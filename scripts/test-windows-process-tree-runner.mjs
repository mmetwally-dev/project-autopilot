#!/usr/bin/env node
// Task 15.4A correction: focused regression coverage for the shared
// TEST-ONLY helper scripts/test-fixtures/windows-process-tree-runner.mjs —
// proving it is genuinely bounded (never leaves its Promise pending,
// regardless of what the child process or `taskkill` does), captures
// output correctly and within a bound, and settles exactly once across
// every close/error/timeout/output-limit race.
//
// Windows-only: this whole file is a no-op PASS on any other platform (the
// helper under test is Windows-specific — it relies on `taskkill`).
//
// Mocking/injection here is scoped exactly to the OS process boundary
// (`spawnFn`/`killFn`, the module's own injection points) — no Autopilot
// workflow logic is reimplemented or exercised; this file only drives the
// shared runner directly against small, disposable Node child processes and
// (for the two OS-boundary-only cases that a real process can't reliably
// reproduce — a child that never emits "close", and a `taskkill` that
// throws) synthetic fakes.
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {spawn} from "node:child_process";
import {runWindowsProcessTreeBounded, DEFAULT_KILL_GRACE_MS, DEFAULT_TASKKILL_TIMEOUT_MS, __testables} from "./test-fixtures/windows-process-tree-runner.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

if (process.platform !== "win32") {
  console.log("SKIP: windows-process-tree-runner coverage — not running on win32.");
  process.exit(0);
}

// -----------------------------------------------------------------------
// Fake child construction (OS-process-boundary injection only): a minimal
// EventEmitter-based double shaped exactly like the subset of
// node:child_process's ChildProcess the runner actually touches
// (`.pid`, `.stdout`/`.stderr` with `.on`/`.destroy`, `.on("error"|"exit"|
// "close", ...)`). Deliberately "inert" by default — it never emits
// anything on its own, so the ONLY way a test using it can settle is
// through the runner's own timeout/backstop machinery, which is exactly
// what items 4/5/7 need to isolate.
// -----------------------------------------------------------------------
function makeInertFakeChild() {
  const child = new EventEmitter();
  child.pid = 999999;
  child.stdout = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr = new EventEmitter();
  child.stderr.destroy = () => {};
  return child;
}

// =======================================================================
// 1. Normal child output and exit code are preserved.
// =======================================================================
async function testNormalCompletion() {
  const r = await runWindowsProcessTreeBounded(process.execPath, ["-e", "console.log('hello-stdout');console.error('hello-stderr');process.exit(3)"], {timeoutMs: 15000});
  check("normal: exit code preserved", r.status === 3, r);
  check("normal: stdout captured", r.stdout.includes("hello-stdout"), r);
  check("normal: stderr captured", r.stderr.includes("hello-stderr"), r);
  check("normal: not reported as timed out", r.timedOut === false, r);
  check("normal: not reported as output-overflowed", r.outputLimitExceeded === false, r);
  check("normal: not reported as a termination failure", r.terminationFailed === false, r);
  check("normal: no spawn error", r.error === null, r);
}

// =======================================================================
// 2. Output delivered before close is fully preserved.
// =======================================================================
async function testOutputBeforeClose() {
  const size = 200000;
  const r = await runWindowsProcessTreeBounded(process.execPath, ["-e", `process.stdout.write("X".repeat(${size}));process.exit(0)`], {timeoutMs: 15000, maxOutputBytes: size + 1000});
  check("before-close: full output captured (not truncated, not dropped)", r.stdout.length === size, {expected: size, actual: r.stdout.length});
  check("before-close: exit code preserved alongside the output", r.status === 0, r);
}

// =======================================================================
// 3. Timeout settles within a bounded grace period.
// =======================================================================
async function testTimeoutBounded() {
  const timeoutMs = 1500;
  const killGraceMs = 500;
  const start = Date.now();
  const r = await runWindowsProcessTreeBounded(process.execPath, ["-e", "setInterval(()=>{},100000)"], {timeoutMs, killGraceMs});
  const elapsed = Date.now() - start;
  check("timeout: reported as timed out", r.timedOut === true, r);
  // A forceful Windows termination (taskkill /F) still delivers a "close"
  // with SOME exit code (commonly nonzero, never the process's own would-be
  // exit 0) rather than a null/signal pair — timedOut:true is the
  // authoritative "this was force-terminated, not a clean run" signal, not
  // the exit code shape.
  check("timeout: not reported as a clean (code 0) exit", r.status !== 0, r);
  check("timeout: settles within a bounded grace period (deadline + grace + generous slack)", elapsed < timeoutMs + killGraceMs + 5000, {elapsed, timeoutMs, killGraceMs});
  check("timeout: settles at or after the deadline itself (not prematurely)", elapsed >= timeoutMs, {elapsed, timeoutMs});
  // A real force-terminated child DOES emit "close" — that is the only
  // evidence the runner accepts as proof the process actually died, so this
  // (and only this) is the shape in which terminationFailed may be false
  // after a termination was requested. It must be handled exactly once.
  check("timeout: termination confirmed by the child's own close event", r.terminationFailed === false, r);
  check("timeout: terminator diagnostics recorded (nothing swallowed)", r.killDiagnostics !== null && r.killDiagnostics.requested === true, r.killDiagnostics);
  check("timeout: the real taskkill reported success", r.killDiagnostics?.reportedSuccess === true, r.killDiagnostics);
}

// =======================================================================
// 3b. The terminator itself is bounded: a synchronous kill that blocks far
//     longer than the grace period cannot leave the Promise pending.
//
//     This is the regression test for the concrete defect: the runner used
//     to arm its backstop timer AFTER calling the (synchronous) terminator,
//     so a blocking `spawnSync("taskkill", ...)` with no timeout meant the
//     backstop was never even scheduled. The backstop is now armed first.
// =======================================================================
async function testBlockingTerminatorCannotHang() {
  const fakeChild = makeInertFakeChild();
  const timeoutMs = 300;
  const killGraceMs = 300;
  const blockMs = 1500;
  const start = Date.now();
  const r = await runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs, killGraceMs,
    spawnFn: () => fakeChild,
    // Busy-wait: blocks the event loop exactly the way an unbounded
    // spawnSync("taskkill") would.
    killFn: () => { const until = Date.now() + blockMs; while (Date.now() < until) { /* block */ } return {status: 0}; }
  });
  const elapsed = Date.now() - start;
  check("blocking-terminator: settles despite a terminator that blocks the event loop", r.timedOut === true, r);
  check("blocking-terminator: settles promptly once the blocking terminator returns (backstop was armed first)", elapsed < timeoutMs + blockMs + killGraceMs + 2000, {elapsed, timeoutMs, blockMs, killGraceMs});
  check("blocking-terminator: no close arrived, so termination is reported as unconfirmed", r.terminationFailed === true, r);
}

// =======================================================================
// 3c. The default terminator passes a strict timeout to taskkill, and
//     really does destroy a live process tree.
// =======================================================================
async function testDefaultTaskkillIsBoundedAndEffective() {
  check("default-taskkill: exposes a short, sane timeout constant", typeof DEFAULT_TASKKILL_TIMEOUT_MS === "number" && DEFAULT_TASKKILL_TIMEOUT_MS > 0 && DEFAULT_TASKKILL_TIMEOUT_MS <= 10000, DEFAULT_TASKKILL_TIMEOUT_MS);
  const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},100000)"], {stdio: "ignore"});
  await new Promise(r => setTimeout(r, 200));
  const start = Date.now();
  const result = __testables.defaultKillProcessTree(victim.pid, {timeoutMs: DEFAULT_TASKKILL_TIMEOUT_MS});
  const elapsed = Date.now() - start;
  check("default-taskkill: returns within its own configured timeout bound", elapsed <= DEFAULT_TASKKILL_TIMEOUT_MS + 1500, {elapsed, DEFAULT_TASKKILL_TIMEOUT_MS});
  check("default-taskkill: reported success against a live process", result?.status === 0, {status: result?.status, error: String(result?.error || "")});
  const closed = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 4000);
    victim.on("exit", () => { clearTimeout(timer); resolve(true); });
  });
  check("default-taskkill: the targeted process actually died", closed === true, {closed});
  try { victim.kill(); } catch { /* already gone */ }
}

// =======================================================================
// 4. A simulated child that never emits "close" still settles through the
//    backstop timer.
// =======================================================================
async function testBackstopWithoutClose() {
  const fakeChild = makeInertFakeChild();
  const timeoutMs = 300;
  const killGraceMs = 300;
  const start = Date.now();
  const r = await runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs, killGraceMs,
    spawnFn: () => fakeChild,
    killFn: () => ({status: 0}) // "succeeds", but the fake child still never emits close/exit
  });
  const elapsed = Date.now() - start;
  check("backstop: settles even though \"close\" never arrived", r.timedOut === true, r);
  check("backstop: settles within deadline + grace (never left pending)", elapsed >= timeoutMs && elapsed < timeoutMs + killGraceMs + 2000, {elapsed, timeoutMs, killGraceMs});
  // The terminator claimed success, but nothing ever confirmed the child
  // died. Reporting that as clean termination would be a false negative —
  // exactly the defect this assertion now pins down.
  check("backstop: a terminator's own claim of success is NOT accepted as proof — terminationFailed is true without close", r.terminationFailed === true, r);
  check("backstop: the terminator's success claim is still preserved separately", r.killDiagnostics?.reportedSuccess === true, r.killDiagnostics);
}

// =======================================================================
// 5. A taskkill failure cannot leave the Promise pending.
// =======================================================================
async function testTaskkillFailureStillSettles() {
  const fakeChild = makeInertFakeChild();
  const timeoutMs = 300;
  const killGraceMs = 300;
  const start = Date.now();
  const r = await runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs, killGraceMs,
    spawnFn: () => fakeChild,
    killFn: () => { throw new Error("simulated taskkill failure"); }
  });
  const elapsed = Date.now() - start;
  // Reaching this line at all is itself proof the Promise settled — a
  // hang would have blown this test file's own outer timeout instead.
  check("taskkill-failure: terminationFailed is reported true", r.terminationFailed === true, r);
  check("taskkill-failure: still reported as timed out", r.timedOut === true, r);
  check("taskkill-failure: the thrown terminator error is surfaced, not swallowed", /simulated taskkill failure/.test(String(r.killDiagnostics?.error || "")), r.killDiagnostics);
  check("taskkill-failure: still settles within a bounded time despite the thrown kill error", elapsed < timeoutMs + killGraceMs + 2000, {elapsed});
}

// =======================================================================
// 5b. A nonzero taskkill exit is a termination failure, not a shrug.
// =======================================================================
async function testNonzeroTaskkillIsTerminationFailure() {
  const fakeChild = makeInertFakeChild();
  const r = await runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs: 300, killGraceMs: 300,
    spawnFn: () => fakeChild,
    // taskkill's real "process not found"/"access denied" shape.
    killFn: () => ({status: 128, error: undefined})
  });
  check("nonzero-taskkill: terminationFailed is reported true", r.terminationFailed === true, r);
  check("nonzero-taskkill: the nonzero exit status is recorded", r.killDiagnostics?.status === 128, r.killDiagnostics);
  check("nonzero-taskkill: it is not reported as a terminator success", r.killDiagnostics?.reportedSuccess === false, r.killDiagnostics);
}

// =======================================================================
// 5c. A terminator that times out is reported as such.
// =======================================================================
async function testTaskkillTimeoutIsDiagnosed() {
  const fakeChild = makeInertFakeChild();
  const timeoutError = new Error("spawnSync taskkill ETIMEDOUT");
  timeoutError.code = "ETIMEDOUT";
  const r = await runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs: 300, killGraceMs: 300,
    spawnFn: () => fakeChild,
    killFn: () => ({status: null, signal: "SIGKILL", error: timeoutError})
  });
  check("taskkill-timeout: reported as a termination failure", r.terminationFailed === true, r);
  check("taskkill-timeout: diagnosed specifically as a terminator timeout", r.killDiagnostics?.timedOut === true, r.killDiagnostics);
}

// =======================================================================
// 5d. A failed taskkill followed by a LATER child close still fails closed.
//
//     A leader `close` does not prove descendants died when `taskkill /T /F`
//     itself failed — terminationFailed stays true. Uses injected children
//     only (no real process timing beyond short local timers).
// =======================================================================
async function testFailedTaskkillPlusLaterCloseFailsClosed() {
  async function oneCase({label, killFn, expectDiagnostics}) {
    const fakeChild = makeInertFakeChild();
    let killCalls = 0;
    let settlements = 0;
    const promise = runWindowsProcessTreeBounded("irrelevant", [], {
      timeoutMs: 300, killGraceMs: 800,
      spawnFn: () => fakeChild,
      killFn: (...args) => { killCalls += 1; return killFn(...args); }
    }).then(value => { settlements += 1; return value; });
    // Close AFTER the deadline has fired and the terminator has run, but
    // BEFORE the backstop settles — isolating exactly the "later close"
    // path. Extra late events prove single settlement.
    setTimeout(() => fakeChild.emit("close", 1, null), 450);
    setTimeout(() => fakeChild.emit("error", new Error("late error after close")), 550);
    setTimeout(() => fakeChild.emit("close", 0, null), 650);
    const r = await promise;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1200));
    check(`${label}: failed taskkill plus later close fails closed`, r.terminationFailed === true, r);
    check(`${label}: still reported as timed out`, r.timedOut === true, r);
    check(`${label}: settled exactly once across the close/error/close race`, settlements === 1, {settlements});
    check(`${label}: the terminator ran exactly once`, killCalls === 1, {killCalls});
    expectDiagnostics(r);
    return r;
  }

  const rNonzero = await oneCase({
    label: "nonzero-taskkill-plus-close",
    killFn: () => ({status: 128, error: undefined}),
    expectDiagnostics: r => {
      check("nonzero-taskkill-plus-close: nonzero status preserved", r.killDiagnostics?.status === 128, r.killDiagnostics);
      check("nonzero-taskkill-plus-close: not reported as success", r.killDiagnostics?.reportedSuccess === false, r.killDiagnostics);
    }
  });

  await oneCase({
    label: "thrown-taskkill-plus-close",
    killFn: () => { throw new Error("simulated taskkill failure"); },
    expectDiagnostics: r => {
      check("thrown-taskkill-plus-close: thrown error preserved", /simulated taskkill failure/.test(String(r.killDiagnostics?.error || "")), r.killDiagnostics);
      check("thrown-taskkill-plus-close: not reported as success", r.killDiagnostics?.reportedSuccess === false, r.killDiagnostics);
    }
  });

  const timeoutError = new Error("spawnSync taskkill ETIMEDOUT");
  timeoutError.code = "ETIMEDOUT";
  await oneCase({
    label: "timedout-taskkill-plus-close",
    killFn: () => ({status: null, signal: null, error: timeoutError}),
    expectDiagnostics: r => {
      check("timedout-taskkill-plus-close: timeout diagnosed", r.killDiagnostics?.timedOut === true, r.killDiagnostics);
      check("timedout-taskkill-plus-close: not reported as success", r.killDiagnostics?.reportedSuccess === false, r.killDiagnostics);
    }
  });

  await oneCase({
    label: "malformed-taskkill-plus-close",
    killFn: () => undefined,
    expectDiagnostics: r => {
      check("malformed-taskkill-plus-close: not reported as success", r.killDiagnostics?.reportedSuccess === false, r.killDiagnostics);
    }
  });
  void rNonzero;
}

async function testSuccessfulTaskkillPlusLaterClose() {
  const fakeChild = makeInertFakeChild();
  let settlements = 0;
  const promise = runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs: 300, killGraceMs: 800,
    spawnFn: () => fakeChild,
    killFn: () => ({status: 0})
  }).then(value => { settlements += 1; return value; });
  setTimeout(() => fakeChild.emit("close", 1, null), 450);
  setTimeout(() => fakeChild.emit("close", 0, null), 650);
  const r = await promise;
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1200));
  check("successful-taskkill-plus-close: close plus reported success clears terminationFailed", r.terminationFailed === false, r);
  check("successful-taskkill-plus-close: still reported as timed out", r.timedOut === true, r);
  check("successful-taskkill-plus-close: success diagnostics preserved", r.killDiagnostics?.reportedSuccess === true, r.killDiagnostics);
  check("successful-taskkill-plus-close: settled exactly once", settlements === 1, {settlements});
}

// =======================================================================
// 6. stdout/stderr exceeding the configured limit fails explicitly without
//    unbounded accumulation.
// =======================================================================
async function testOutputLimitExceeded() {
  const limit = 1024;
  const killGraceMs = 500;
  const start = Date.now();
  // Writes far more than the limit, then hangs forever — proves the
  // OUTPUT-LIMIT path (not the outer deadline) is what terminates it.
  const r = await runWindowsProcessTreeBounded(process.execPath, ["-e", "process.stdout.write('Y'.repeat(1000000));setInterval(()=>{},100000)"], {timeoutMs: 20000, killGraceMs, maxOutputBytes: limit});
  const elapsed = Date.now() - start;
  check("overflow: outputLimitExceeded is reported true", r.outputLimitExceeded === true, r);
  check("overflow: stdout is bounded at (not beyond) the configured limit", r.stdout.length <= limit, {limit, actual: r.stdout.length});
  check("overflow: the runaway process was terminated, not left running (not a clean code-0 exit)", r.status !== 0, r);
  check("overflow: settled via the output-limit path, not the (much longer) outer deadline", elapsed < killGraceMs + 10000, {elapsed, killGraceMs});
}

// =======================================================================
// 6b. The cap counts BYTES, not JavaScript string length.
//
//     The child writes 500 U+20AC characters: 500 UTF-16 code units but
//     1500 UTF-8 bytes. With a 900-unit cap the old string-length rule
//     would have seen 500 < 900 and happily retained all 1500 bytes — 66%
//     over the configured budget. A real byte cap must overflow here.
// =======================================================================
async function testMultibyteOutputIsBoundedByBytes() {
  const limitBytes = 900;
  const charCount = 500;
  const r = await runWindowsProcessTreeBounded(process.execPath, [
    "-e", `process.stdout.write("\\u20AC".repeat(${charCount}));process.exit(0)`
  ], {timeoutMs: 15000, killGraceMs: 800, maxOutputBytes: limitBytes});
  check("multibyte: the byte cap triggered even though the character count is under the limit", r.outputLimitExceeded === true, {chars: r.stdout.length, limitBytes});
  check("multibyte: fewer characters retained than the limit — proving a character-count cap is NOT what fired", r.stdout.length < limitBytes, {chars: r.stdout.length, limitBytes});
  // Truncating mid-codepoint can turn a partial sequence into one U+FFFD,
  // which re-encodes to 3 bytes; allow exactly that much slack and no more.
  check("multibyte: retained output does not exceed the byte budget", Buffer.byteLength(r.stdout, "utf8") <= limitBytes + 3, {bytes: Buffer.byteLength(r.stdout, "utf8"), limitBytes});
}

// =======================================================================
// 6c. stdout and stderr are budgeted independently, not against a shared
//     pool — each stream gets the full maxOutputBytes.
// =======================================================================
async function testStreamsHaveIndependentByteLimits() {
  const limitBytes = 4096;
  const perStream = 3000; // under the cap individually, over it combined
  const r = await runWindowsProcessTreeBounded(process.execPath, [
    "-e", `process.stdout.write("a".repeat(${perStream}));process.stderr.write("b".repeat(${perStream}));process.exit(0)`
  ], {timeoutMs: 15000, maxOutputBytes: limitBytes});
  check("independent-limits: no overflow when each stream is under the cap but their sum is over it", r.outputLimitExceeded === false, {stdout: r.stdout.length, stderr: r.stderr.length, limitBytes});
  check("independent-limits: stdout fully retained", r.stdout.length === perStream, {actual: r.stdout.length, expected: perStream});
  check("independent-limits: stderr fully retained", r.stderr.length === perStream, {actual: r.stderr.length, expected: perStream});

  // And the stderr side of the cap is real on its own.
  const rErr = await runWindowsProcessTreeBounded(process.execPath, [
    "-e", `process.stderr.write("c".repeat(50000));process.stdout.write("tiny");process.exit(0)`
  ], {timeoutMs: 15000, killGraceMs: 800, maxOutputBytes: 1024});
  check("independent-limits: an oversized stderr alone trips the cap", rErr.outputLimitExceeded === true, {stderr: rErr.stderr.length});
  check("independent-limits: stderr is bounded at its own limit", Buffer.byteLength(rErr.stderr, "utf8") <= 1024 + 3, {bytes: Buffer.byteLength(rErr.stderr, "utf8")});
}

// =======================================================================
// 7. close/error/timeout races settle exactly once.
// =======================================================================
async function testNoSpuriousTerminationOnNormalClose() {
  let killCalled = false;
  const r = await runWindowsProcessTreeBounded(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 15000,
    killFn: pid => { killCalled = true; return {status: 0}; }
  });
  check("no-spurious-termination: a normal completion never invokes the kill path", killCalled === false, {killCalled});
  check("no-spurious-termination: settled via close, not timeout", r.timedOut === false && r.status === 0, r);
}

async function testCloseWinsOverLaterTimeout() {
  const fakeChild = makeInertFakeChild();
  let killCalled = false;
  const promise = runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs: 500, killGraceMs: 300,
    spawnFn: () => fakeChild,
    killFn: () => { killCalled = true; return {status: 0}; }
  });
  // Fire close almost immediately, well before the 500ms deadline.
  setTimeout(() => fakeChild.emit("close", 0, null), 20);
  const r = await promise;
  // Wait past where the deadline+grace WOULD have fired if it hadn't been
  // cancelled by the close-triggered settlement, to prove no second
  // settlement/termination attempt occurs afterward.
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1200));
  check("close-wins: settled via close, not the later timeout", r.timedOut === false && r.status === 0, r);
  check("close-wins: the deadline timer was genuinely cancelled (kill never invoked)", killCalled === false, {killCalled});
}

// =======================================================================
// 7b. Every race path settles exactly once: a close followed by a late
//     "error" and a late "exit", with a deadline that would otherwise have
//     fired, yields one and only one settlement — the close.
// =======================================================================
async function testAllRacePathsSettleExactlyOnce() {
  const fakeChild = makeInertFakeChild();
  let settlements = 0;
  let killCalled = 0;
  const promise = runWindowsProcessTreeBounded("irrelevant", [], {
    timeoutMs: 400, killGraceMs: 200,
    spawnFn: () => fakeChild,
    killFn: () => { killCalled += 1; return {status: 0}; }
  }).then(value => { settlements += 1; return value; });

  setTimeout(() => fakeChild.emit("exit", 0, null), 10);
  setTimeout(() => fakeChild.emit("close", 0, null), 20);
  setTimeout(() => fakeChild.emit("error", new Error("late error after close")), 40);
  setTimeout(() => fakeChild.emit("close", 7, null), 60);

  const r = await promise;
  // Wait well past deadline + grace to catch any second settlement or a
  // late termination attempt scheduled by the (already cancelled) deadline.
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1200));
  check("race: settled exactly once", settlements === 1, {settlements});
  check("race: the winning settlement is the first close", r.status === 0 && r.error === null && r.timedOut === false, r);
  check("race: no termination was ever attempted", killCalled === 0, {killCalled});
  check("race: not reported as a termination failure", r.terminationFailed === false, r);
}

// =======================================================================
// 7c. The overflow path also settles exactly once when the real child does
//     close after being terminated.
// =======================================================================
async function testOverflowThenCloseSettlesOnce() {
  let settlements = 0;
  // The child swallows stdout errors: after the runner destroys its side of
  // the pipes on overflow, the pending 500KB write would otherwise crash the
  // child with EPIPE *before* taskkill runs, making taskkill report
  // "process not found" (status 128) — a genuine terminator failure that
  // must stay failed even though a close follows. Swallowing keeps the child
  // alive so taskkill deterministically finds and terminates a live tree,
  // which is what this test exercises: overflow → terminate → close.
  const r = await runWindowsProcessTreeBounded(process.execPath, [
    "-e", "process.stdout.on('error',()=>{});process.stdout.write('Z'.repeat(500000));setInterval(()=>{},100000)"
  ], {timeoutMs: 20000, killGraceMs: 800, maxOutputBytes: 1024})
    .then(value => { settlements += 1; return value; });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1500));
  check("overflow-once: settled exactly once", settlements === 1, {settlements});
  check("overflow-once: overflow reported", r.outputLimitExceeded === true, r);
  // Fail-closed: terminationFailed clears only because BOTH hold here — the
  // real taskkill reported success AND the child's close arrived. A failed
  // taskkill followed by a close stays failed (see the 5d tests above).
  check("overflow-once: successful taskkill plus close clears terminationFailed", r.terminationFailed === false && r.killDiagnostics?.reportedSuccess === true, r);
  check("overflow-once: never misreported as a successful clean run", r.status !== 0 || r.outputLimitExceeded === true, r);
}

// =======================================================================
// 8. No test process descendants remain afterward.
// =======================================================================
async function testNoDescendantsSurviveTimeout() {
  const marker = `windows-process-tree-runner-leak-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // A raw `cmd.exe /c "<quoted command line>"` argv is fragile — Node's own
  // Windows argument-escaping for a single array element containing nested
  // quotes does not reliably round-trip through cmd.exe's own parser. The
  // production winShimInvocation() (scripts/agent-process.mjs) sidesteps
  // this entirely by invoking `cmd.exe /d /s /c <path-to-a-.cmd-file>` — a
  // bare, unquoted-content path, exactly mirrored here — so this test
  // exercises the SAME real .cmd-trampoline shape used elsewhere in these
  // Windows test files (test-windows-disposable-plan-reviewer.mjs's
  // cursor-agent.cmd), not a hand-rolled command line.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-ptr-leak-"));
  const scriptPath = path.join(binDir, "leak-child.mjs");
  fs.writeFileSync(scriptPath, `setInterval(()=>{/*${marker}*/},100000);\n`);
  const cmdPath = path.join(binDir, "leak-child.cmd");
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`);

  try {
    const r = await runWindowsProcessTreeBounded("cmd.exe", ["/d", "/s", "/c", cmdPath], {timeoutMs: 2000, killGraceMs: 800});
    check("descendant-cleanup: the process tree was terminated (timedOut)", r.timedOut === true, r);

    // Give Windows a brief moment to finish reaping after taskkill /T /F.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    const survivorCheck = spawnSync("powershell", ["-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' -or $_.CommandLine -like '*${binDir.replace(/\\/g, "\\\\")}*' } | Measure-Object).Count`
    ], {encoding: "utf8"});
    const survivorCount = parseInt((survivorCheck.stdout || "0").trim(), 10) || 0;
    check("descendant-cleanup: no surviving cmd.exe/node.exe descendant of the terminated tree remains", survivorCount === 0, {survivorCount, stderr: survivorCheck.stderr});
  } finally {
    try { fs.rmSync(binDir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// =======================================================================
// Interactive stdin: prompt-driven answers via stdin pipe.
// =======================================================================
async function testInteractiveStdin() {
  const script = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({input: process.stdin, output: process.stdout});",
    "rl.question('PROMPT-ONE: ', a => {",
    "  console.log('GOT-ONE:' + String(a).trim());",
    "  rl.question('PROMPT-TWO: ', b => {",
    "    console.log('GOT-TWO:' + String(b).trim());",
    "    rl.close();",
    "    try { process.stdin.destroy(); } catch {}",
    "  });",
    "});"
  ].join("\n");
  let answeredOne = false;
  let answeredTwo = false;
  const r = await runWindowsProcessTreeBounded(process.execPath, ["-e", script], {
    timeoutMs: 15000,
    stdin: "pipe",
    onOutput: ({stdout, writeLine}) => {
      if (!answeredOne && stdout.includes("PROMPT-ONE")) {
        answeredOne = true;
        writeLine("answer-one");
      } else if (answeredOne && !answeredTwo && stdout.includes("PROMPT-TWO")) {
        answeredTwo = true;
        writeLine("answer-two");
      }
    }
  });
  check("interactive: answers delivered", r.stdout.includes("GOT-ONE:answer-one") && r.stdout.includes("GOT-TWO:answer-two"), r.stdout.slice(-500));
  check("interactive: run stays clean", r.status === 0 && r.timedOut === false && r.outputLimitExceeded === false && r.terminationFailed === false && r.error === null, r);
  check("interactive: answers counted", r.answersSent === 2, r.answersSent);
}

// =======================================================================
// Run everything and report.
// =======================================================================
async function main() {
  const start = Date.now();
  check("DEFAULT_KILL_GRACE_MS is a small, sane positive number", typeof DEFAULT_KILL_GRACE_MS === "number" && DEFAULT_KILL_GRACE_MS > 0 && DEFAULT_KILL_GRACE_MS <= 15000, DEFAULT_KILL_GRACE_MS);

  await testNormalCompletion();
  await testOutputBeforeClose();
  await testTimeoutBounded();
  await testBlockingTerminatorCannotHang();
  await testDefaultTaskkillIsBoundedAndEffective();
  await testBackstopWithoutClose();
  await testTaskkillFailureStillSettles();
  await testNonzeroTaskkillIsTerminationFailure();
  await testTaskkillTimeoutIsDiagnosed();
  await testFailedTaskkillPlusLaterCloseFailsClosed();
  await testSuccessfulTaskkillPlusLaterClose();
  await testOutputLimitExceeded();
  await testMultibyteOutputIsBoundedByBytes();
  await testStreamsHaveIndependentByteLimits();
  await testNoSpuriousTerminationOnNormalClose();
  await testCloseWinsOverLaterTimeout();
  await testAllRacePathsSettleExactlyOnce();
  await testOverflowThenCloseSettlesOnce();
  await testNoDescendantsSurviveTimeout();
  await testInteractiveStdin();

  const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n(total runtime: ${elapsedSeconds}s)`);

  if (failures) {
    console.error(`\n${failures} windows-process-tree-runner check(s) failed.`);
    process.exit(1);
  }
  console.log("\nwindows-process-tree-runner PASS");
}

await main();
