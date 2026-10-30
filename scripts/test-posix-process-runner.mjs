#!/usr/bin/env node
// Focused deterministic regression coverage for the POSIX bounded
// process-tree runner (scripts/test-fixtures/posix-process-runner.mjs).
//
// Covers: normal exit, nonzero diagnostics, deadline timeout, SIGTERM
// escalation, descendant termination, stdout/stderr byte caps, single
// settlement under concurrency and duplicate events, and backstop
// settlement when `close` is never observed (via an injected fake spawn).
//
// POSIX-only: SKIPs (exit 0) on Windows. No production code is involved;
// no real agent CLI, browser, or network is used anywhere here.
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {runPosixBounded, runTreeUntilMarker} from "./test-fixtures/posix-process-runner.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("SKIP: POSIX process-runner regression — not running on win32.");
  process.exit(0);
}

const NODE = process.execPath;

// 1. normal exit: status, captured output, clean flags.
{
  const r = await runPosixBounded(NODE, ["-e", 'console.log("hello-normal")'], {timeoutMs: 10000});
  check("1. normal exit reports status 0", r.status === 0, r);
  check("1. normal exit captures stdout", r.stdout.trim() === "hello-normal", r.stdout);
  check("1. normal exit sets no failure flags",
    r.timedOut === false && r.outputLimitExceeded === false && r.terminationFailed === false && r.error === null, r);
}

// 2. nonzero exit diagnostics.
{
  const r = await runPosixBounded(NODE, ["-e", 'console.error("boom-diag"); process.exit(3);'], {timeoutMs: 10000});
  check("2. nonzero exit reports status 3", r.status === 3, r);
  check("2. nonzero exit captures stderr", r.stderr.includes("boom-diag"), r.stderr);
  check("2. nonzero exit is not a timeout", r.timedOut === false && r.terminationFailed === false, r);
}

// 3. deadline timeout kills and reports.
{
  const start = Date.now();
  const r = await runPosixBounded(NODE, ["-e", "setTimeout(() => {}, 30000);"], {timeoutMs: 500, killGraceMs: 300, backstopMs: 2000});
  const elapsed = Date.now() - start;
  check("3. timeout sets timedOut", r.timedOut === true, r);
  check("3. timeout kills promptly (well under the child sleep)", elapsed < 10000, elapsed);
  check("3. timed-out tree is confirmed dead", r.terminationFailed === false, r);
}

// 4. SIGTERM-resistant child is escalated to SIGKILL.
{
  const start = Date.now();
  const r = await runPosixBounded(NODE, ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000);'], {timeoutMs: 500, killGraceMs: 300, backstopMs: 2000});
  const elapsed = Date.now() - start;
  check("4. SIGTERM-resistant child still terminates (escalation)", r.timedOut === true && elapsed < 10000, {elapsed, r});
  check("4. escalation reports a kill signal", r.signal === "SIGKILL" || r.signal === "SIGTERM", r.signal);
}

// 5. descendant/process-tree termination via heartbeat freeze.
{
  const hb = `${process.env.TMPDIR || "/tmp"}/ap-posix-runner-hb-${process.pid}.log`;
  const {writeFileSync, readFileSync, existsSync, rmSync} = await import("node:fs");
  try { rmSync(hb, {force: true}); } catch { /* ignore */ }
  const r = await runPosixBounded(NODE, ["-e",
    `import {spawn} from "node:child_process"; spawn("bash", ["-c", "while true; do date +%s%N >> ${hb}; sleep 0.2; done"], {stdio: "ignore"}); setTimeout(() => {}, 30000);`
  // The deadline leaves room for node + bash to start and write a first
  // heartbeat on a loaded machine (800ms was not enough under a parallel suite).
  ], {timeoutMs: 5000, killGraceMs: 300, backstopMs: 2000});
  check("5. group kill settles the call", r.timedOut === true, r);
  await new Promise(res => setTimeout(res, 900));
  const first = existsSync(hb) ? readFileSync(hb, "utf8") : "";
  await new Promise(res => setTimeout(res, 900));
  const second = existsSync(hb) ? readFileSync(hb, "utf8") : "";
  check("5. descendant heartbeat froze (tree is dead)", first.length > 0 && first === second, {first: first.length, second: second.length});
  try { rmSync(hb, {force: true}); } catch { /* ignore */ }
}

// 6/7. stdout and stderr byte caps (ASCII behavior unchanged).
{
  const cap = 64 * 1024;
  const r = await runPosixBounded(NODE, ["-e", 'const s = "x".repeat(1024); for (let i = 0; i < 600; i++) console.log(s);'], {timeoutMs: 15000, maxOutputBytes: cap});
  check("6. stdout overflow sets outputLimitExceeded", r.outputLimitExceeded === true, {len: r.stdout.length});
  check("6. stdout capture is bounded by the cap", Buffer.byteLength(r.stdout) <= cap, Buffer.byteLength(r.stdout));
  check("6. verbose child still exits normally", r.status === 0 && r.timedOut === false, r.status);
  const r2 = await runPosixBounded(NODE, ["-e", 'const s = "e".repeat(1024); for (let i = 0; i < 600; i++) console.error(s);'], {timeoutMs: 15000, maxOutputBytes: cap});
  check("7. stderr overflow sets outputLimitExceeded", r2.outputLimitExceeded === true, {len: r2.stderr.length});
  check("7. stderr capture is bounded by the cap", Buffer.byteLength(r2.stderr) <= cap, Buffer.byteLength(r2.stderr));
}

// 6b/7b. genuine multibyte output: raw captured bytes never exceed the cap
// (byte bounding, not UTF-16 slicing), the flag is set, ASCII behavior is
// unchanged, and a split sequence neither throws nor explodes into
// unbounded replacement output. Cap 100 against 3-byte U+20AC lands the
// truncation point inside a character on the very first chunk,
// deterministically; cap 102 against 4-byte emoji likewise.
{
  const r = await runPosixBounded(NODE, ["-e", 'process.stdout.write("€".repeat(2000));'], {timeoutMs: 15000, maxOutputBytes: 100});
  check("6b. multibyte stdout raw bytes never exceed the cap", Buffer.byteLength(r.stdout) <= 100, Buffer.byteLength(r.stdout));
  check("6b. multibyte stdout sets outputLimitExceeded", r.outputLimitExceeded === true, r.outputLimitExceeded);
  check("6b. multibyte stdout keeps only complete characters", r.stdout === "€".repeat(33), r.stdout.length);
  check("6b. multibyte stdout child still exits normally", r.status === 0 && r.timedOut === false, r.status);
  const r2 = await runPosixBounded(NODE, ["-e", 'process.stderr.write("😀".repeat(2000));'], {timeoutMs: 15000, maxOutputBytes: 102});
  check("7b. multibyte stderr raw bytes never exceed the cap", Buffer.byteLength(r2.stderr) <= 102, Buffer.byteLength(r2.stderr));
  check("7b. multibyte stderr sets outputLimitExceeded", r2.outputLimitExceeded === true, r2.outputLimitExceeded);
  check("7b. multibyte stderr keeps only complete characters", r2.stderr === "😀".repeat(25), r2.stderr.length);
  // Split-sequence robustness: many small writes force chunk boundaries
  // through multibyte characters; capture stays bounded and well-formed.
  const r3 = await runPosixBounded(NODE, ["-e", 'for (let i = 0; i < 4000; i++) process.stdout.write("é");'], {timeoutMs: 15000, maxOutputBytes: 100});
  check("7c. split multibyte sequence stays bounded and decodes cleanly",
    Buffer.byteLength(r3.stdout) <= 100 && r3.stdout === "é".repeat(50) && r3.outputLimitExceeded === true,
    {bytes: Buffer.byteLength(r3.stdout), len: r3.stdout.length});
}

// U1-U5. cross-chunk UTF-8 correctness via an injected fake child (exact
// chunk control — no reliance on OS pipe chunking).
{
  let nextFakePid = 910000000;
  const fakeChildWithIO = ({stdoutChunks = [], stderrChunks = [], exitCode = 0} = {}) => {
    const emitter = new EventEmitter();
    emitter.pid = nextFakePid++;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    return () => {
      queueMicrotask(() => {
        for (const chunk of stdoutChunks) emitter.stdout.emit("data", chunk);
        for (const chunk of stderrChunks) emitter.stderr.emit("data", chunk);
        emitter.emit("exit", exitCode, null);
        emitter.emit("close", exitCode, null);
      });
      return emitter;
    };
  };

  // U1. two-byte character split across two data events.
  {
    const r = await runPosixBounded("fake", [], {
      timeoutMs: 5000, spawnFn: fakeChildWithIO({stdoutChunks: [Buffer.from([0xC3]), Buffer.from([0xA9])]})
    });
    check("U1. stdout [0xC3] then [0xA9] returns exactly é",
      r.stdout === "é" && Buffer.byteLength(r.stdout, "utf8") === 2 && r.outputLimitExceeded === false, {stdout: r.stdout});
  }

  // U2. four-byte emoji split across three data events on stderr.
  {
    const r = await runPosixBounded("fake", [], {
      timeoutMs: 5000,
      spawnFn: fakeChildWithIO({stderrChunks: [Buffer.from([0xF0]), Buffer.from([0x9F, 0x98]), Buffer.from([0x80])]})
    });
    check("U2. stderr emoji split across three chunks returns exactly that emoji",
      r.stderr === "😀" && Buffer.byteLength(r.stderr, "utf8") === 4 && r.outputLimitExceeded === false, {stderr: r.stderr});
  }

  // U3. valid character split exactly at the byte-cap boundary stays
  // well-formed and bounded, reporting truncation honestly.
  {
    const r = await runPosixBounded("fake", [], {
      timeoutMs: 5000, maxOutputBytes: 100,
      spawnFn: fakeChildWithIO({stdoutChunks: [Buffer.from("A".repeat(99), "utf8"), Buffer.from([0xE2]), Buffer.from([0x82, 0xAC])]})
    });
    check("U3. cap-boundary split stays well-formed and bounded",
      r.stdout === "A".repeat(99) && Buffer.byteLength(r.stdout, "utf8") <= 100 && r.outputLimitExceeded === true,
      {len: r.stdout.length, bytes: Buffer.byteLength(r.stdout, "utf8")});
  }

  // U4. fully malformed input: byte length of the returned string stays
  // within the cap and overflow is reported honestly.
  {
    const r = await runPosixBounded("fake", [], {
      timeoutMs: 5000, maxOutputBytes: 100,
      spawnFn: fakeChildWithIO({stdoutChunks: [Buffer.alloc(100, 0xFF)]})
    });
    check("U4. 100 malformed bytes decode within the cap with honest overflow",
      Buffer.byteLength(r.stdout, "utf8") <= 100 && r.outputLimitExceeded === true && r.stdout === "�".repeat(33),
      {bytes: Buffer.byteLength(r.stdout, "utf8"), len: r.stdout.length});
  }

  // U5. per-stream independence: overflowing stdout leaves stderr intact.
  {
    const r = await runPosixBounded("fake", [], {
      timeoutMs: 5000, maxOutputBytes: 64,
      spawnFn: fakeChildWithIO({
        stdoutChunks: [Buffer.from("x".repeat(5000), "utf8")],
        stderrChunks: [Buffer.from("small-stderr", "utf8")]
      })
    });
    check("U5. stdout overflow does not disturb the stderr stream",
      r.stderr === "small-stderr" && Buffer.byteLength(r.stdout, "utf8") <= 64 && r.outputLimitExceeded === true,
      {stderr: r.stderr, outBytes: Buffer.byteLength(r.stdout, "utf8")});
  }
}

// 5b. normal-exit descendant cleanup: the leader exits 0 while a
// background heartbeat descendant (ignored stdio) lives on. The runner
// must still terminate the group and confirm its death WITHOUT marking a
// timeout, preserving the leader's status.
{
  const hb = `${process.env.TMPDIR || "/tmp"}/ap-posix-runner-hb-normal-${process.pid}.log`;
  const {writeFileSync, readFileSync, existsSync, rmSync} = await import("node:fs");
  try { rmSync(hb, {force: true}); } catch { /* ignore */ }
  const r = await runPosixBounded(NODE, ["-e",
    `import {spawn} from "node:child_process"; import {statSync} from "node:fs"; const g = spawn("bash", ["-c", "while true; do date +%s%N >> ${hb}; sleep 0.2; done"], {stdio: "ignore"}); g.unref(); setInterval(() => { try { if (statSync("${hb}").size > 0) process.exit(0); } catch {} }, 50);`
  // The leader exits once the descendant has written its first heartbeat
  // (not after a fixed delay, which a loaded machine can outrun).
  ], {timeoutMs: 15000, killGraceMs: 300, backstopMs: 2000});
  check("5b. leader status 0 preserved through descendant cleanup", r.status === 0, r);
  check("5b. no timeout is reported for a clean leader exit", r.timedOut === false, r);
  check("5b. group death confirmed after normal exit", r.terminationFailed === false, r);
  await new Promise(res => setTimeout(res, 900));
  const first = existsSync(hb) ? readFileSync(hb, "utf8") : "";
  await new Promise(res => setTimeout(res, 900));
  const second = existsSync(hb) ? readFileSync(hb, "utf8") : "";
  check("5b. descendant heartbeat froze (tree is dead)", first.length > 0 && first === second, {first: first.length, second: second.length});
  try { rmSync(hb, {force: true}); } catch { /* ignore */ }
}

// 8. single settlement: concurrent distinct markers + duplicate events.
{
  const runs = await Promise.all(Array.from({length: 25}, (_, i) =>
    runPosixBounded(NODE, ["-e", `console.log("marker-${i}")`], {timeoutMs: 10000})));
  check("8. concurrent runs all settle exactly once with correct output",
    runs.every((r, i) => r.status === 0 && r.stdout.trim() === `marker-${i}` && r.timedOut === false),
    runs.map(r => r.stdout.trim()));
  // Duplicate error/exit/close events settle once with the right result.
  const flaky = new EventEmitter();
  flaky.pid = 987654321;
  const fakeSpawn = () => {
    queueMicrotask(() => {
      flaky.emit("exit", 0, null);
      flaky.emit("close", 0, null);
      flaky.emit("error", new Error("late-error"));
      flaky.emit("exit", 1, null);
      flaky.emit("close", 1, null);
    });
    return flaky;
  };
  const r = await runPosixBounded("fake", [], {timeoutMs: 5000, spawnFn: fakeSpawn});
  check("8. duplicate events settle once with the first result", r.status === 0 && r.signal === null, r);
}

// 9. backstop: `close` never observed settles bounded with terminationFailed.
{
  const silent = new EventEmitter();
  silent.pid = 987654320;
  const silentSpawn = () => silent; // never emits anything
  const start = Date.now();
  const r = await runPosixBounded("fake", [], {timeoutMs: 200, killGraceMs: 100, backstopMs: 300, spawnFn: silentSpawn});
  const elapsed = Date.now() - start;
  check("9. backstop settles instead of hanging", r.timedOut === true, r);
  check("9. unconfirmed termination is flagged", r.terminationFailed === true, r);
  check("9. backstop settlement is prompt and bounded", elapsed < 8000, elapsed);
}

if (failures) {
  console.error(`\n${failures} POSIX process-runner regression check(s) failed.`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// M1-M4. marker-triggered complete tree termination (runTreeUntilMarker).
// ---------------------------------------------------------------------
const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-posix-marker-"));
try {
  // M1. pre-existing marker: deterministic immediate marker kill.
  {
    const marker = path.join(markerRoot, "m1");
    fs.writeFileSync(marker, "present-before-spawn\n");
    const r = await runTreeUntilMarker(NODE, ["-e", "setTimeout(() => {}, 30000);"], {markerFile: marker, pollMs: 20, timeoutMs: 15000});
    check("M1. pre-existing marker triggers the kill", r.markerObserved === true && r.killed === true, r);
    check("M1. termination confirmed without timeout", r.terminationConfirmed === true && r.timedOut === false, r);
  }

  // M2. descendant dies with the tree: heartbeat grandchild + marker, then
  // a long sleep the leader would otherwise survive. The marker is written
  // only after the descendant has proven itself alive (heartbeat observed),
  // so the freeze assertion below cannot pass vacuously on a stillborn
  // descendant.
  {
    const marker = path.join(markerRoot, "m2");
    const hb = path.join(markerRoot, "m2-hb.log");
    const r = await runTreeUntilMarker(NODE, ["-e",
      `import fs from "node:fs"; import {spawn} from "node:child_process";
       const hbPath = ${JSON.stringify(hb)};
       spawn("bash", ["-c", "while true; do date +%s%N >> " + hbPath + "; sleep 0.2; done"], {stdio: "ignore"});
       for (let n = 0; n < 100; n++) {
         try {
           if (fs.readFileSync(hbPath, "utf8").trim().split("\\n").length >= 2) break;
         } catch {}
         await new Promise(res => setTimeout(res, 100));
       }
       fs.writeFileSync(${JSON.stringify(marker)}, "reached\\n");
       setTimeout(() => {}, 30000);`
    ], {markerFile: marker, pollMs: 20, timeoutMs: 30000});
    check("M2. marker kill settles with the tree confirmed dead",
      r.markerObserved === true && r.killed === true && r.terminationConfirmed === true && r.terminationFailed === false, r);
    await new Promise(res => setTimeout(res, 900));
    const first = fs.existsSync(hb) ? fs.readFileSync(hb, "utf8") : "";
    await new Promise(res => setTimeout(res, 900));
    const second = fs.existsSync(hb) ? fs.readFileSync(hb, "utf8") : "";
    check("M2. no post-kill descendant writes (heartbeat frozen)", first.length > 0 && first === second, {first: first.length, second: second.length});
  }

  // M3. no marker before the deadline: hard timeout still terminates the
  // tree and reports honestly.
  {
    const marker = path.join(markerRoot, "m3-absent");
    const r = await runTreeUntilMarker(NODE, ["-e", "setTimeout(() => {}, 30000);"], {markerFile: marker, pollMs: 20, timeoutMs: 600});
    check("M3. missing marker ends in timeout, not a silent pass",
      r.timedOut === true && r.markerObserved === false, r);
    check("M3. deadline path still terminates and confirms the tree",
      r.killed === true && r.terminationConfirmed === true && r.terminationFailed === false, r);
  }

  // M4. clean fast exit before any trigger: nothing killed, status kept.
  {
    const marker = path.join(markerRoot, "m4-absent");
    const r = await runTreeUntilMarker(NODE, ["-e", 'console.log("quick-done");'], {markerFile: marker, pollMs: 20, timeoutMs: 15000});
    check("M4. clean exit reports status 0 with nothing killed",
      r.status === 0 && r.killed === false && r.timedOut === false && r.markerObserved === false, r);
    check("M4. clean exit output captured", r.stdout.trim() === "quick-done", r.stdout);
  }

  // M5. readyWhen ends a deliberate hang early, with the tree confirmed dead.
  // The probe turns true on its own (no file written by the child, mirroring
  // a read-only role), then the runner waits settleMs before killing.
  {
    const started = Date.now();
    const r = await runTreeUntilMarker(NODE, ["-e", "setTimeout(() => {}, 30000);"], {
      markerFile: path.join(markerRoot, "m5-absent"),
      readyWhen: () => Date.now() - started >= 250,
      settleMs: 100,
      pollMs: 20,
      timeoutMs: 15000
    });
    const elapsed = Date.now() - started;
    check("M5. readyWhen kill is reported as observed, not timed out",
      r.readyObserved === true && r.killed === true && r.timedOut === false && r.markerObserved === false, r);
    check("M5. readyWhen kill confirms the tree dead",
      r.terminationConfirmed === true && r.terminationFailed === false, r);
    check("M5. readyWhen ends the wait well before the deadline", elapsed >= 300 && elapsed < 5000, elapsed);
  }

  // M6. readyWhen that never fires leaves the deadline as the safety net.
  {
    const r = await runTreeUntilMarker(NODE, ["-e", "setTimeout(() => {}, 30000);"], {
      markerFile: path.join(markerRoot, "m6-absent"),
      readyWhen: () => false,
      pollMs: 20,
      timeoutMs: 600
    });
    check("M6. unfired readyWhen still ends in the deadline path",
      r.timedOut === true && r.readyObserved === false && r.markerObserved === false, r);
    check("M6. deadline path still confirms the tree dead", r.killed === true && r.terminationConfirmed === true, r);
  }
} finally {
  try { fs.rmSync(markerRoot, {recursive: true, force: true}); } catch { /* best-effort */ }
}

// I1. interactive stdin: prompt-driven answers are delivered via stdin pipe,
// output is captured, lifecycle stays clean (no timeout, no overflow, tree
// confirmed dead). Regression coverage for runPosixBounded stdin/onOutput.
{
  const script = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({input: process.stdin, output: process.stdout});",
    "rl.question('PROMPT-ONE: ', a => {",
    "  console.log('GOT-ONE:' + a.trim());",
    "  rl.question('PROMPT-TWO: ', b => {",
    "    console.log('GOT-TWO:' + b.trim());",
    "    rl.close();",
    "    try { process.stdin.destroy(); } catch {}",
    "  });",
    "});"
  ].join("\n");
  let answeredOne = false;
  let answeredTwo = false;
  const r = await runPosixBounded(NODE, ["-e", script], {
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
  check("I1. interactive answers delivered", r.stdout.includes("GOT-ONE:answer-one") && r.stdout.includes("GOT-TWO:answer-two"), r.stdout.slice(-500));
  check("I1. interactive run stays clean", r.status === 0 && r.timedOut === false && r.outputLimitExceeded === false && r.terminationFailed === false && r.error === null, r);
  check("I1. interactive answers counted", r.answersSent === 2, r.answersSent);
}

if (failures) {
  console.error(`\n${failures} POSIX process-runner regression check(s) failed (marker suite).`);
  process.exit(1);
}
console.log("\nPOSIX process-runner regression PASS");
