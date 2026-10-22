#!/usr/bin/env node
// Phase 3 task 8 — atomic state-write helper tests.
//
// Imports the helper directly (never a test hook inside `autopilot.mjs`,
// which runs `main()` at import and cannot be imported). Proves:
// - exact-byte preservation (two-space JSON shape, no trailing newline);
// - the write mechanism is rename-only publish: the destination is never
//   written directly (a non-atomic swap-in fails these assertions);
// - an interrupted write leaves either the previous complete state or the
//   new complete state, never partial JSON;
// - a transient rename failure is retried once after the documented backoff
//   (event-ordered: fail, sleep, success), and a forced persistent rename
//   failure raises rather than silently falling back to a non-atomic write;
// - crash-debris temps of dead processes are reaped while live-process and
//   non-pid temps are preserved;
// - the `saveState()` wiring in `scripts/autopilot.mjs` calls the helper
//   with the historical serialization while `write()` is untouched (read as
//   source text; `autopilot.mjs` is never imported).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {atomicWriteFileSync, siblingTempPath, RENAME_RETRY_DELAYS_MS, ORPHAN_TEMP_MAX_AGE_MS} from "./atomic-state-write.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(...dirs) {
  for (const dir of dirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// Recording filesystem boundary: delegates every call to the real `fs`
// while logging the mechanism as events. Lets the tests assert HOW the
// destination was published (temp-write then rename), not just the final
// bytes — which is what distinguishes an atomic implementation from a
// direct `writeFileSync(dest)` swap-in.
function makeRecordingIo(events) {
  const describe = (a) => typeof a === "string" ? path.basename(a) : (typeof a === "number" ? "fd(number)" : typeof a);
  const io = {};
  for (const key of ["mkdirSync", "openSync", "writeFileSync", "fsyncSync", "closeSync", "renameSync", "unlinkSync", "readdirSync", "statSync"]) {
    io[key] = (...args) => {
      if (key === "renameSync") {
        try {
          const out = fs[key](...args);
          events.push(`renameSync ok ${describe(args[0])} -> ${describe(args[1])}`);
          return out;
        } catch (e) {
          events.push(`renameSync throw ${describe(args[0])} -> ${describe(args[1])}`);
          throw e;
        }
      }
      events.push(`${key} ${describe(args[0])}`);
      return fs[key](...args);
    };
  }
  return io;
}

// ── Exact bytes: shape, two-space formatting, no trailing newline ─────────
{
  const dir = makeDir("ap-atomic-bytes-");
  try {
    const dest = path.join(dir, "nested", "state.json");
    const state = {version: 1, phase: "implementing", phaseIndex: 0};
    const bytes = JSON.stringify({...state, updatedAt: "2026-01-01T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, bytes);
    const raw = fs.readFileSync(dest, "utf8");
    check("bytes preserved exactly", raw === bytes);
    check("no trailing newline (state.json has none)", !raw.endsWith("\n"));
    check("two-space formatting preserved", raw.includes('\n  "version"'));
    check("round-trips to the same state", JSON.stringify(JSON.parse(raw)) === JSON.stringify(JSON.parse(bytes)));
    check("no temp file remains after success", !fs.existsSync(siblingTempPath(dest)));
    check("parent directories created", fs.statSync(path.dirname(dest)).isDirectory());
  } finally { cleanup(dir); }
}

// ── Mechanism: rename-only publish, temp fsynced before rename ────────────
// A plain non-atomic `writeFileSync(dest, content)` swap-in produces a
// `writeFileSync state.json` event and no rename event, so it fails the
// first two assertions below while still passing every byte-level check —
// which is exactly why the mechanism (not just the outcome) is asserted.
{
  const dir = makeDir("ap-atomic-mechanism-");
  try {
    const dest = path.join(dir, "state.json");
    const destBase = path.basename(dest);
    const tmpBase = path.basename(siblingTempPath(dest));
    const events = [];
    const io = makeRecordingIo(events);
    const bytes = JSON.stringify({version: 1, phase: "mechanism", updatedAt: "2026-01-01T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, bytes, {io, sleep: () => {}});
    const directWrites = events.filter((e) => e === `writeFileSync ${destBase}` || e === `openSync ${destBase}`);
    check("mechanism: destination never written directly (rename-only publish)", directWrites.length === 0, directWrites);
    // Coupled with the line above: an implementation that bypasses the
    // injected boundary entirely records no events at all, so the absence
    // of direct writes alone would pass vacuously — the temp write must be
    // positively observed through the boundary too.
    check("mechanism: temp write observed through the boundary",
      events.includes(`writeFileSync fd(number)`) && events.some((e) => e === `openSync ${tmpBase}`), events);
    check("mechanism: temp published via rename over destination",
      events.includes(`renameSync ok ${tmpBase} -> ${destBase}`), events);
    const fsyncAt = events.indexOf("fsyncSync fd(number)");
    const renameAt = events.indexOf(`renameSync ok ${tmpBase} -> ${destBase}`);
    check("mechanism: temp fsynced before rename", fsyncAt !== -1 && renameAt !== -1 && fsyncAt < renameAt, events);
    check("mechanism: destination holds exact bytes", fs.readFileSync(dest, "utf8") === bytes);
  } finally { cleanup(dir); }
}

// ── Interrupted write: old-complete or new-complete, never partial ────────
{
  const dir = makeDir("ap-atomic-crash-");
  try {
    const dest = path.join(dir, "state.json");
    const stateA = JSON.stringify({version: 1, phase: "implementing", n: 1, updatedAt: "2026-01-01T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, stateA);

    // Simulate a process killed after the temp write but before the rename:
    // partial bytes exist ONLY at the sibling temp path.
    fs.writeFileSync(siblingTempPath(dest), '{"version":1,"pha');
    check("crashed temp is invisible to readers (old complete state intact)",
      fs.readFileSync(dest, "utf8") === stateA);

    // Completing the write truncates the stale temp and renames correctly.
    const stateB = JSON.stringify({version: 1, phase: "verifying", n: 2, updatedAt: "2026-01-02T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, stateB);
    check("completed write observes only the new complete state", fs.readFileSync(dest, "utf8") === stateB);
    check("no temp file remains after recovery", !fs.existsSync(siblingTempPath(dest)));
  } finally { cleanup(dir); }
}

// ── Crash before any state exists: absent or complete, never partial ──────
{
  const dir = makeDir("ap-atomic-first-");
  try {
    const dest = path.join(dir, "state.json");
    fs.writeFileSync(siblingTempPath(dest), '{"version":1,"pha');
    check("no destination yet (crash before first rename)", !fs.existsSync(dest));
    const stateC = JSON.stringify({version: 1, phase: "idle", updatedAt: "2026-01-03T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, stateC);
    check("first completed write observes only complete JSON", fs.readFileSync(dest, "utf8") === stateC);
  } finally { cleanup(dir); }
}

// ── Transient rename failure is retried with escalating backoff ─────────
{
  const dir = makeDir("ap-atomic-retry-");
  try {
    const dest = path.join(dir, "state.json");
    const tmpBase = path.basename(siblingTempPath(dest));
    const destBase = path.basename(dest);
    const before = JSON.stringify({version: 1, phase: "before", updatedAt: "2026-01-01T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, before);
    const after = JSON.stringify({version: 1, phase: "after", updatedAt: "2026-01-02T00:00:00.000Z"}, null, 2);
    // Inject a rename that throws EPERM once (the Native Windows
    // transient-lock shape) and delegates to the real rename after that.
    // (Monkey-patching `fs.renameSync` does not cross ES module boundaries,
    // so the `{io}` seam is the deterministic boundary wrap.)
    const events = [];
    const io = makeRecordingIo(events);
    const innerRename = io.renameSync;
    let calls = 0;
    io.renameSync = (...args) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("EPERM: operation not permitted, rename");
        err.code = "EPERM";
        throw err;
      }
      return innerRename(...args);
    };
    const sleeps = [];
    atomicWriteFileSync(dest, after, {io, sleep: (ms) => { events.push(`sleep ${ms}`); sleeps.push(ms); }});
    check("rename retry: failed first rename is retried (exactly two calls)", calls === 2, calls);
    check("rename retry: backoff waited between attempts (fail, sleep, success)",
      sleeps.length === 1 && sleeps[0] === RENAME_RETRY_DELAYS_MS[0] &&
      events.indexOf(`sleep ${RENAME_RETRY_DELAYS_MS[0]}`) < events.indexOf(`renameSync ok ${tmpBase} -> ${destBase}`),
      events);
    // The temp is rewritten before re-renaming: the failed attempt's temp
    // may have been removed out from under us, and content is deterministic.
    check("rename retry: temp rewritten before the second rename",
      events.filter((e) => e === `openSync ${tmpBase}`).length === 2, events);
    check("rename retry: destination holds the new exact bytes", fs.readFileSync(dest, "utf8") === after);
    check("rename retry: no temp file remains", !fs.existsSync(siblingTempPath(dest)));
  } finally { cleanup(dir); }
}

// ── Rewrite failure consumes budget too (shared AV-hold repro) ───────────
// Rename throwing EPERM while the temp's reopen also throws EPERM (one hold
// on the directory) must run the full budget — sleeps [200, 1000] — rather
// than aborting after the first sleep. The surfaced error is the last
// attempt's, caused by the first, so the rename failure is not hidden.
{
  const dir = makeDir("ap-atomic-avhold-");
  try {
    const dest = path.join(dir, "state.json");
    const bytes = JSON.stringify({version: 1, phase: "avhold", updatedAt: "2026-01-01T00:00:00.000Z"}, null, 2);
    const events = [];
    const io = makeRecordingIo(events);
    const eperm = (op) => {
      const err = new Error(`EPERM: operation not permitted, ${op}`);
      err.code = "EPERM";
      return err;
    };
    io.renameSync = (...args) => { events.push(`renameSync throw ${path.basename(args[0])} -> ${path.basename(args[1])}`); throw eperm("rename"); };
    // The initial temp write succeeds; every reopen afterwards fails — one
    // hold on the directory failing the rename and the reopen together.
    let opens = 0;
    const innerOpen = io.openSync;
    io.openSync = (...args) => {
      opens += 1;
      events.push(`openSync ${path.basename(args[0])}`);
      if (opens === 1) return innerOpen(...args);
      throw eperm("open");
    };
    const sleeps = [];
    let propagated = null;
    try {
      atomicWriteFileSync(dest, bytes, {io, sleep: (ms) => { events.push(`sleep ${ms}`); sleeps.push(ms); }});
    } catch (e) {
      propagated = e;
    }
    check("av-hold: full budget consumed despite rewrite failures",
      JSON.stringify(sleeps) === JSON.stringify([...RENAME_RETRY_DELAYS_MS]), {sleeps, events});
    check("av-hold: surfaced error caused by the first failure",
      propagated?.code === "EPERM" && propagated?.cause?.code === "EPERM", propagated && {code: propagated.code, cause: propagated.cause?.code});
    check("av-hold: nothing published", !fs.existsSync(dest));
  } finally { cleanup(dir); }
}

// ── Close error never masks the original write error ─────────────────────
{
  const dir = makeDir("ap-atomic-closemask-");
  try {
    const dest = path.join(dir, "state.json");
    const events = [];
    const io = makeRecordingIo(events);
    io.writeFileSync = () => {
      const err = new Error("ENOSPC: no space left on device, write");
      err.code = "ENOSPC";
      throw err;
    };
    io.closeSync = () => {
      const err = new Error("EIO: i/o error, close");
      err.code = "EIO";
      throw err;
    };
    let propagated = null;
    try {
      atomicWriteFileSync(dest, '{"version":1}', {io, sleep: () => {}});
    } catch (e) {
      propagated = e;
    }
    check("close masking: original ENOSPC propagates, not the follow-on EIO",
      propagated?.code === "ENOSPC", propagated && {code: propagated.code, message: propagated.message});
    check("close masking: failed temp removed", !fs.existsSync(siblingTempPath(dest)));
    check("close masking: no destination published", !fs.existsSync(dest));
  } finally { cleanup(dir); }
}

// ── Forced rename failure raises; never a silent non-atomic fallback ──────
{
  const dir = makeDir("ap-atomic-renamefail-");
  try {
    // A non-empty directory at the destination path makes every rename
    // fail on all platforms (file onto non-empty dir).
    const dest = path.join(dir, "state.json");
    fs.mkdirSync(dest, {recursive: true});
    fs.writeFileSync(path.join(dest, "anchor.txt"), "anchor");
    const events = [];
    const io = makeRecordingIo(events);
    const sleeps = [];
    let threw = false;
    try {
      atomicWriteFileSync(dest, '{"version":1}', {io, sleep: (ms) => { events.push(`sleep ${ms}`); sleeps.push(ms); }});
    } catch {
      threw = true;
    }
    check("forced rename failure raises", threw);
    // Every attempt went through the boundary with escalating backoff
    // between attempts — the retry is attempted, never skipped — and no
    // fallback publish followed the persistent failure.
    const destBase = path.basename(dest);
    const tmpBase = path.basename(siblingTempPath(dest));
    check("forced rename failure: all attempts tried with escalating backoff, no fallback publish",
      events.filter((e) => e === `renameSync throw ${tmpBase} -> ${destBase}`).length === 1 + RENAME_RETRY_DELAYS_MS.length &&
      JSON.stringify(sleeps) === JSON.stringify([...RENAME_RETRY_DELAYS_MS]) &&
      !events.some((e) => e === `writeFileSync ${destBase}` || e === `openSync ${destBase}`),
      {events, sleeps});
    check("destination untouched (still a directory, no fallback file)",
      fs.statSync(dest).isDirectory() && fs.readFileSync(path.join(dest, "anchor.txt"), "utf8") === "anchor");
    check("temp cleaned up after persistent failure", !fs.existsSync(siblingTempPath(dest)));
  } finally { cleanup(dir); }
}

// ── Crash debris: stale+dead reaped, everything uncertain kept ───────────
// Pid numberspaces differ across OS instances sharing one file (WSL2 and
// Windows write the same physical state.json), so ESRCH alone cannot prove
// abandonment: a temp is reaped only when it is BOTH stale by age (a live
// writer's temp is always seconds old) AND pid-dead or pid-unparseable.
{
  const dir = makeDir("ap-atomic-orphan-");
  let child = null;
  const backdate = (p) => {
    const old = new Date(Date.now() - ORPHAN_TEMP_MAX_AGE_MS - 60_000);
    fs.utimesSync(p, old, old);
  };
  try {
    const dest = path.join(dir, "state.json");
    // A surely-dead pid: spawnSync waits for exit before returning it. The
    // pid is probed for ESRCH immediately before use so the premise is
    // deterministic rather than assumed (a recycled pid would pass the
    // keep-assertion for the wrong reason).
    const probeDead = (pid) => {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
      try { process.kill(pid, 0); return false; }
      catch (e) { return e?.code === "ESRCH"; }
    };
    let deadPid = null;
    for (let i = 0; i < 5 && deadPid === null; i += 1) {
      const cand = spawnSync(process.execPath, ["-e", ""], {stdio: "ignore"}).pid;
      if (probeDead(cand)) deadPid = cand;
    }
    // Stale + dead: debris, reaped. The pid is probed again AFTER the run:
    // if Windows recycled it mid-test (correct behavior then keeps the
    // file), the keep-branch is asserted instead — either branch is
    // deterministic, so this can never go red on correct code.
    const orphanChecks = [];
    if (deadPid === null) {
      console.log("SKIP orphan stale-dead case (no provably-dead pid available)");
    } else {
      const orphan = `${dest}.tmp-${deadPid}`;
      fs.writeFileSync(orphan, '{"stale":true');
      backdate(orphan);
      orphanChecks.push(orphan);
    }
    // Fresh + provably dead: possibly a live writer in another pid
    // namespace — kept until it ages out. Candidates are probed for ESRCH
    // first so a recycled neighbour cannot pass this for the wrong reason.
    let freshDead = null;
    for (const cand of [deadPid === null ? -1 : deadPid - 1, deadPid === null ? -1 : deadPid + 1, 2 ** 24 + 7]) {
      if (probeDead(cand)) { freshDead = `${dest}.tmp-${cand}`; break; }
    }
    if (freshDead === null) {
      console.log("SKIP orphan fresh-dead case (no provably-dead neighbour pid)");
    } else {
      fs.writeFileSync(freshDead, '{"fresh":true');
    }
    // A live process's temp must survive the sweep at any age.
    child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {stdio: "ignore"});
    if (typeof child.unref === "function") child.unref();
    const liveTemp = `${dest}.tmp-${child.pid}`;
    fs.writeFileSync(liveTemp, '{"partial":true');
    backdate(liveTemp);
    // A non-pid sibling: kept while fresh, reaped once stale.
    const oddFresh = `${dest}.tmp-notapid`;
    fs.writeFileSync(oddFresh, '{"odd":true');
    const oddStale = `${dest}.tmp-alsoodd`;
    fs.writeFileSync(oddStale, '{"odd":true');
    backdate(oddStale);
    const bytes = JSON.stringify({version: 1, phase: "orphan", updatedAt: "2026-01-04T00:00:00.000Z"}, null, 2);
    atomicWriteFileSync(dest, bytes);
    for (const orphan of orphanChecks) {
      const pid = Number(path.basename(orphan).split(".tmp-")[1]);
      let stillDead = false;
      try { process.kill(pid, 0); }
      catch (e) { stillDead = e?.code === "ESRCH"; }
      if (stillDead) {
        check("orphan: stale dead-pid temp reaped after success", !fs.existsSync(orphan));
      } else {
        check("orphan: recycled pid temp correctly kept (fail-safe)", fs.existsSync(orphan));
      }
    }
    if (freshDead !== null) {
      check("orphan: fresh dead-pid temp kept (namespace-uncertain)", fs.existsSync(freshDead));
    }
    check("orphan: live-pid temp preserved at any age", fs.existsSync(liveTemp));
    check("orphan: fresh non-pid sibling preserved", fs.existsSync(oddFresh));
    check("orphan: stale non-pid sibling reaped", !fs.existsSync(oddStale));
    check("orphan: destination holds exact bytes", fs.readFileSync(dest, "utf8") === bytes);
  } finally {
    try { child?.kill(); } catch { /* best-effort */ }
    cleanup(dir);
  }
}

// ── Input validation fails closed ─────────────────────────────────────────
{
  const dir = makeDir("ap-atomic-inputs-");
  try {
    for (const [label, args] of [
      ["empty dest", ["", "{}"]],
      ["non-string content (object)", [path.join(dir, "a.json"), {}]],
      ["non-string content (null)", [path.join(dir, "b.json"), null]],
    ]) {
      let threw = false;
      try { atomicWriteFileSync(...args); } catch (e) { threw = e instanceof TypeError; }
      check(`invalid input (${label}) throws TypeError`, threw);
    }
  } finally { cleanup(dir); }
}

// ── saveState() wiring without importing the CLI ──────────────────────────
// Compared whitespace-insensitively: a reformat must not fail with a
// misleading "serialization regressed" message — only a token-level change
// (different callee, different serialization expression) fails these.
{
  const source = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");
  const compact = (s) => s.replace(/\s+/g, "");
  const flat = compact(source);
  check("autopilot.mjs imports the helper",
    flat.includes(compact('import {atomicWriteFileSync} from "./atomic-state-write.mjs";')));
  check("saveState() calls the helper with the historical serialization",
    flat.includes(compact("const saveState=s=>{linkDetachedOrchestratorLog(s);atomicWriteFileSync(statePath,JSON.stringify({...s,updatedAt:now()},null,2));};")));
  check("saveState() no longer calls write() directly",
    !flat.includes(compact("const saveState=s=>write(statePath")));
  check("shared write() definition unchanged",
    flat.includes(compact("const write=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s)};")));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
