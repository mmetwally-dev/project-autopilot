#!/usr/bin/env node
// Backlog #41 (TASK-35): idle-hang watchdog + fast opencode rate-limit
// detection. Mission 024 runs 98/99 each waited the full 60-min
// per-task timeout on an opencode session that had stopped answering.
//
// Part A: unit coverage of the watchdog module (resolver defaults, message
// wording, rate-limit line matching, log tailing, write snapshots, process
// enumeration incl. the Windows branch via injection).
// Part B: behavioral session harness — a mini-relay that wires the module
// EXACTLY like runRelay does (chunk -> noteIdleOutput, 1s-style tick ->
// evaluateIdleWatch, SIGTERM then SIGKILL after the production grace on a
// trip) and drives tiny fake adapters through cases 1-8:
//   1. silent, no child, no writes -> killed at about idle_hang_ms, IDLE_HANG
//   2. silent + live child -> NOT killed while the child lives (exits 0)
//   3. silent + file write every second -> not killed (exits 0)
//   4. output every second -> not killed (exits 0)
//   5. output, then silence -> killed about idle_hang_ms after LAST output
//   6. idle_hang_ms: 0 -> watchdog off (silent session exits 0)
//   7. config validation: negative / non-integer / >= per-task deadline
//      rejected with a clear error; 0 and absent accepted
//   8. rate limit: a single hit for THIS session.id + rateLimitGapMs of
//      silence -> RATE_LIMITED (provider/model named); single hit + normal
//      output -> spared (output cancels the pending confirmation); stale
//      (pre-session) lines never count; backlog
//      #36: foreign session.id lines on the shared log ignored, unattributed
//      lines ignored on the shared log but counted for the private bound
//      store, pre-known-id lines never counted
// Part C (WSL/Linux only — same skip rule as
// test-review-feedback-persistence Part 2): twin-loop proof. One
// standalone and one SpecKit REAL `ap run` mission with a silently-hanging
// fake adapter and idle_hang_ms=3000 each record IDLE_HANG
// (infrastructure, retryable) in a run result. The watchdog lives in the
// single shared runRelay(), so both frameworks tripping it there IS the
// twin-loop coverage.
// Static wiring checks (autopilot.mjs source) pin the relay integration
// the same way test-cap-breach-wiring.mjs does (autopilot.mjs runs main()
// on import, so live runRelay is not importable).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  createIdleWatch, evaluateIdleWatch, noteIdleOutput, noteIdleStderrText,
  rateLimitLineInfo, findOpencodeLogFile, readLogAppend, hasLiveWorkProcess,
  snapshotWorkWrites, writesSince, formatIdleHangMessage, formatRateLimitedMessage,
  adapterMarkerFor, isChainCommand, extractSessionIdFromChunk, extractLogSessionId,
  noteIdleSessionId,
  RATE_LIMIT_CONFIRM_MATCHES, RATE_LIMIT_CONFIRM_GAP_MS, IDLE_HANG_KILL_GRACE_MS,
  __testables
} from "./idle-hang-watchdog.mjs";
import {resolveIdleHangMs, resolveFirstOutputMs, IDLE_HANG_MS_DEFAULT} from "./per-task-budget.mjs";
import {validatePolicyConfig} from "./config-validation.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {FAILURE_CLASSES, failure} from "./failure-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const IS_WIN = process.platform === "win32";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

// ===========================================================================
// Part A: unit coverage.
// ===========================================================================
check("A: default is 10 minutes", IDLE_HANG_MS_DEFAULT === 600000, IDLE_HANG_MS_DEFAULT);
check("A: absent policy resolves to the default",
  resolveIdleHangMs({}) === 600000 && resolveIdleHangMs({}, 45 * 60 * 1000) === 600000);
check("A: explicit 0 disables", resolveIdleHangMs({idle_hang_ms: 0}) === 0);
check("A: explicit value below the deadline wins",
  resolveIdleHangMs({idle_hang_ms: 3000}, 60000) === 3000);
check("A: value at/above the deadline degrades to off (never a silent never-fires)",
  resolveIdleHangMs({idle_hang_ms: 60000}, 60000) === 0 && resolveIdleHangMs({idle_hang_ms: 99999}, 60000) === 0);
check("A: default is fitted below a short deadline",
  resolveIdleHangMs({}, 300000) === 300000 - 1, resolveIdleHangMs({}, 300000));
check("A: IDLE_HANG class exists", FAILURE_CLASSES.includes("IDLE_HANG"));
{
  const f = failure("IDLE_HANG", "infrastructure", true, [{source: "relay", message: "m"}]);
  check("A: IDLE_HANG builds as infrastructure + retryable",
    f.class === "IDLE_HANG" && f.domain === "infrastructure" && f.retryable === true, f);
}
check("A: idle message names role, adapter, model and idle time",
  formatIdleHangMessage({role: "implementer", adapter: "opencode", model: "opencode/muse-spark", idleMs: 600000})
    === "IDLE_HANG: implementer (opencode, opencode/muse-spark) produced no output, ran no command and wrote no file for 10 min");
check("A: rate-limit message names provider/model and the WSL re-login hint",
  formatRateLimitedMessage({role: "implementer", adapter: "opencode", model: "opencode/muse-spark", provider: "opencode"})
    .includes("opencode auth login") && formatRateLimitedMessage({role: "implementer", adapter: "opencode", model: "m", provider: "opencode"}).includes("RATE_LIMITED: implementer"));
check("A: production confirmation window is 1 match / 60s",
  RATE_LIMIT_CONFIRM_MATCHES === 1 && RATE_LIMIT_CONFIRM_GAP_MS === 60000);
check("A: kill grace matches the relay deadline/cap pattern (SIGTERM + SIGKILL after 5s)",
  IDLE_HANG_KILL_GRACE_MS === 5000);

// Rate-limit line matching against the REAL observed shapes (mission 024).
const RL_HIT = 'timestamp=2026-09-07T06:16:03.600Z level=ERROR message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free error.error="AI_APICallError: Error from provider (Console): Upstream request failed: [rate_limit_exceeded] Rate limit exceeded. Please retry after a brief wait."';
const RL_RETRY_HIT = 'timestamp=2026-09-07T06:16:05.000Z level=ERROR providerID=opencode modelID=muse-spark-1.3-contributor-free error.error="AI_RetryError: Failed after 3 attempts. Last error: [rate_limit_exceeded] Rate limit exceeded."';
const RL_CONNREFUSED = 'timestamp=2026-08-25T04:35:40.183Z level=ERROR providerID=opencode modelID=hy3-free error.error="AI_RetryError: Failed after 3 attempts. Last error: Cannot connect to API: Unable to connect."';
{
  const hit = rateLimitLineInfo(RL_HIT);
  check("A: real APICallError rate-limit line matches with provider/model",
    hit?.provider === "opencode" && hit?.model === "muse-spark-1.3-contributor-free", hit);
  const retry = rateLimitLineInfo(RL_RETRY_HIT);
  check("A: RetryError WITH the rate-limit marker matches", retry?.provider === "opencode", retry);
  check("A: RetryError WITHOUT the marker (connection refused) does NOT match",
    rateLimitLineInfo(RL_CONNREFUSED) === null);
  check("A: model prose never matches", rateLimitLineInfo("the model wrote: Rate limit exceeded is a normal message") === null
    && rateLimitLineInfo("") === null);

// Backlog #36: session attribution. opencode's stdout events carry
// "sessionID" (quoted JSON); its logfmt log lines carry session.id=.
check("A: stdout sessionID event extracts",
  extractSessionIdFromChunk('{"type":"step_start","sessionID":"ses_ours123"}') === "ses_ours123"
  && extractSessionIdFromChunk('{ "type" : "text" , "sessionID" : "ses_a" }') === "ses_a");
check("A: stdout without a session event extracts nothing",
  extractSessionIdFromChunk("plain progress line") === null
  && extractSessionIdFromChunk("") === null
  && extractSessionIdFromChunk('{"type":"text","part":{"type":"text"}}') === null);
check("A: log session.id extracts (or null when unattributed)",
  extractLogSessionId("level=ERROR session.id=ses_foreign9 error=x") === "ses_foreign9"
  && extractLogSessionId("level=ERROR error.error=\"AI_RetryError: boom\"") === null
  && extractLogSessionId("") === null);
{
  // noteIdleSessionId is first-wins and stable for the session.
  const w = createIdleWatch({idleHangMs: 3000, pid: 999999999, now: 1000000});
  check("A: session id starts unknown", w.sessionId === null);
  check("A: first id wins, later ids do not replace it",
    noteIdleSessionId(w, "ses_first") === "ses_first"
    && noteIdleSessionId(w, "ses_second") === "ses_first"
    && w.sessionId === "ses_first");
  check("A: blank ids are refused",
    noteIdleSessionId(createIdleWatch({idleHangMs: 1, pid: 1}), "  ") === null);
}
}

// Log tailing: newest .log, append-only reads, rotation handled.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-log-"));
  try {
    check("A: no log dir -> null (best-effort, never throws)",
      findOpencodeLogFile(path.join(tmp, "missing")) === null);
    fs.mkdirSync(path.join(tmp, "log"), {recursive: true});
    check("A: empty log dir -> null", findOpencodeLogFile(tmp) === null);
    const old = path.join(tmp, "log", "opencode.log.1");
    const cur = path.join(tmp, "log", "opencode.log");
    fs.writeFileSync(old, "old\n");
    fs.writeFileSync(cur, "line1\n");
    const hourAgo = new Date(Date.now() - 3600000);
    fs.utimesSync(old, hourAgo, hourAgo);
    check("A: newest .log wins", findOpencodeLogFile(tmp) === cur);
    fs.appendFileSync(cur, "line2\nline3\n");
    const size = fs.statSync(cur).size;
    const part = readLogAppend(cur, 6);
    check("A: append read returns only new bytes with the next offset",
      part.text === "line2\nline3\n" && part.nextOffset === size, part);
    const rotated = readLogAppend(cur, size + 100);
    check("A: shrunk/rotated log rescans from 0 instead of going blind",
      rotated.text.includes("line1") && rotated.nextOffset === size, rotated.nextOffset);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

// Write snapshots: activity detected, .autopilot/.git/node_modules excluded.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-writes-"));
  try {
    fs.writeFileSync(path.join(repo, "work.txt"), "v1");
    fs.mkdirSync(path.join(repo, ".autopilot", "runs"), {recursive:true});
    fs.writeFileSync(path.join(repo, ".autopilot", "runs", "status.json"), "{}");
    fs.mkdirSync(path.join(repo, "node_modules", "dep"), {recursive:true});
    fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "x");
    const snap = snapshotWorkWrites({repoRoot: repo});
    check("A: baseline snapshot is available", !snap.unavailable, snap);
    check("A: quiet tree reports no writes", writesSince(snap, {repoRoot: repo}) === false);
    fs.writeFileSync(path.join(repo, "work.txt"), "v2");
    check("A: repo write is detected", writesSince(snap, {repoRoot: repo}) === true);
    const snap2 = snapshotWorkWrites({repoRoot: repo});
    fs.writeFileSync(path.join(repo, ".autopilot", "runs", "status.json"), '{"n":1}');
    fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "y");
    check("A: monitor's own .autopilot writes and node_modules churn do NOT count",
      writesSince(snap2, {repoRoot: repo}) === false);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-scratch-"));
    try {
      const snap3 = snapshotWorkWrites({repoRoot: repo, scratchDir: scratch});
      fs.writeFileSync(path.join(scratch, "tool-out.txt"), "data");
      check("A: scratch-dir write is detected", writesSince(snap3, {repoRoot: repo, scratchDir: scratch}) === true);
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// Process enumeration, live on this platform. The observation root is a
// spawned "adapter" (never our own process: on Windows our own pid carries
// conhost phantoms from the enumerators we spawn ourselves — parented to
// the observer, invisible to any adapter walk in production).
// File-based (not node -e) so the chain marker is meaningful, exactly like
// production (launch binary/script basename).
function writeAdapterFile(dir, name, code) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, code);
  return file;
}
{
  const addir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-ad-"));
  const loneFile = writeAdapterFile(addir, "fake-adapter-.cjs", "setTimeout(()=>{},30000);");
  const adapter = spawn(process.execPath, [loneFile], {shell: false, stdio: "ignore"});
  await new Promise(r => setTimeout(r, 300));
  try {
    check("A: lone adapter process reads as no work",
      hasLiveWorkProcess(adapter.pid, {markers: ["fake-adapter-.cjs"]}) === false);
  } finally {
    try { adapter.kill("SIGKILL"); } catch { /* already gone */ }
  }
  // Tool child spawned BY the adapter: visible as work, gone afterwards.
  const workerFile = writeAdapterFile(addir, "fake-adapter-.cjs", [
    'const {spawn} = require("node:child_process");',
    'const kid = spawn(process.execPath, ["-e", "setTimeout(()=>{},4000);"], {shell:false, stdio:"ignore"});',
    'kid.on("spawn", () => { process.stdout.write("ready\\n"); });',
    'kid.on("exit", () => process.exit(0));',
    'setTimeout(() => process.exit(3), 15000);',
    "",
  ].join("\n"));
  const worker = spawn(process.execPath, [workerFile], {shell: false, stdio: ["ignore", "pipe", "ignore"]});
  const markers = ["fake-adapter-.cjs"];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("adapter never reported its tool child")), 10000);
      worker.stdout.on("data", d => {
        if (String(d).includes("ready")) { clearTimeout(timer); resolve(); }
      });
      worker.on("exit", () => { clearTimeout(timer); resolve(); });
    });
    check("A: live tool child of the adapter is detected",
      hasLiveWorkProcess(worker.pid, {markers}) === true);
    const found = IS_WIN
      ? __testables.windowsDescendants(worker.pid)
      : __testables.linuxDescendants(worker.pid);
    const work = (found.entries || []).filter(e => !isChainCommand(e.cmdline, markers));
    check("A: descendant listing carries the tool child as work",
      !found.unknown && work.length >= 1 && /setTimeout/.test(work[0].cmdline),
      {unknown: found.unknown, count: (found.entries || []).length});
    await new Promise(resolve => worker.on("exit", resolve));
    await new Promise(r => setTimeout(r, 800));
    check("A: no descendants once the tool is gone", hasLiveWorkProcess(worker.pid, {markers}) === false);
  } finally {
    try { worker.kill("SIGKILL"); } catch { /* already gone */ }
    if (IS_WIN) {
      try { spawnSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], {stdio: "ignore", shell: false, timeout: 10000}); } catch { /* best-effort */ }
    }
    fs.rmSync(addir, {recursive: true, force: true});
  }
  check("A: bad pid never reads as work", hasLiveWorkProcess(-1) === false && hasLiveWorkProcess(999999999) === false);

// Chain markers: the launcher chain is recognized by command line, never by
// pid or timing (CIM CreationDate has 1s resolution — the adapter and its
// first tool shared one second live on Windows).
check("A: binary basename marks the launcher (extensionless covers .cmd/.exe)",
  adapterMarkerFor("C:\\bin\\cursor-agent.cmd", []) === "cursor-agent"
  && adapterMarkerFor("/usr/local/bin/opencode", []) === "opencode"
  && adapterMarkerFor("/usr/local/bin/claude", []) === "claude");
check("A: generic runtime falls back to the script it runs",
  adapterMarkerFor(process.execPath, ["/tmp/fake-adapter-.cjs"]) === "fake-adapter-.cjs"
  && adapterMarkerFor("cmd.exe", ["/d", "/s", "/c", "C:\\bin\\cursor-agent.cmd"]) === "cursor-agent.cmd");
check("A: chain match is the launcher argv[0]/script basename, case-insensitive (not a substring elsewhere)",
  isChainCommand('cmd.exe /d /s /c C:\\bin\\CURSOR-AGENT.cmd run', ["cursor-agent"]) === true
  && isChainCommand('node "C:\\x\\cursor-agent.js"', ["cursor-agent"]) === true
  && isChainCommand('node "C:\\x\\cursor-agent\\cli.js"', ["cursor-agent"]) === false
  && isChainCommand('"C:\\Program Files\\nodejs\\node.exe" -e setTimeout(()=>{},20000);', ["cursor-agent"]) === false
  && isChainCommand("", ["cursor-agent"]) === false);
{
  // The REAL observed trampoline tree (native Windows probe): cmd(.cmd)
  // and the shim's node are chain, the -e tool is work.
  const table = [
    {pid: 12968, ppid: 1, cmdline: "cmd.exe /d /s /c C:\\t\\tramp-probe.cmd tool"},
    {pid: 14884, ppid: 12968, cmdline: 'node  ""C:\\t\\tramp-probe-target.js"" tool'},
    {pid: 21148, ppid: 14884, cmdline: '"C:\\Program Files\\nodejs\\node.exe"" -e setTimeout(()=>{},20000);'},
  ];
  const chainOf = pid => {
    const kids = [];
    const stack = [pid];
    const seen = new Set([pid]);
    const byParent = new Map();
    for (const r of table) {
      if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
      byParent.get(r.ppid).push(r);
    }
    while (stack.length) {
      for (const c of byParent.get(stack.pop()) || []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        kids.push(c);
        stack.push(c.pid);
      }
    }
    return kids;
  };
  const markers = ["tramp-probe"];
  const kids = chainOf(12968);
  check("A: observed trampoline (.cmd + shim node) is chain, tool is work",
    kids.length === 2
    && isChainCommand(kids.find(k => k.pid === 14884).cmdline, markers) === true
    && isChainCommand(kids.find(k => k.pid === 21148).cmdline, markers) === false);
  check("A: quote-aware CSV keeps the doubled-quote cmdline intact",
    (__testables.parseProcessCsv('"ProcessId","ParentProcessId","CommandLine"\n"14884","12968","node  ""C:\\\\t\\\\x.js"" tool"\n') || [])[0]?.cmdline === 'node  "C:\\\\t\\\\x.js" tool');
}
}

// Windows branch deterministically on ANY platform (injected table).
{
  const table = "Node,ParentProcessId,ProcessId\nAAA,100,101\nAAA,101,102\nAAA,200,201\n";
  const fakeSpawn = (cmd, args) => ({error: null, stdout: table});
  const found = __testables.windowsDescendants(100, {spawnSyncFn: fakeSpawn});
  const pids = (found.entries || []).map(e => e.pid);
  check("A: Windows DFS finds transitive descendants",
    !found.unknown && pids.includes(101) && pids.includes(102) && !pids.includes(201), found);
  const noTable = __testables.windowsDescendants(100, {spawnSyncFn: () => ({error: new Error("no wmic")})});
  check("A: unreadable Windows table reads as unknown (never a hang signal)", noTable.unknown === true);
  check("A: CSV without the PID columns is unusable",
    __testables.parseProcessCsv("Foo,Bar\n1,2\n") === null && __testables.parseProcessCsv("") === null);
}

// Idempotence / clock-reset logic with a fake clock (fast, deterministic).
{
  const t0 = 1000000;
  const watch = createIdleWatch({idleHangMs: 3000, pid: 123456789, now: t0});
  check("A: quiet for less than the window is ok",
    evaluateIdleWatch(watch, {now: t0 + 2999}).status === "ok");
  noteIdleOutput(watch, t0 + 2000);
  check("A: output resets the clock (without the note, t0+3000 would already be hung)",
    evaluateIdleWatch(watch, {now: t0 + 3000}).status === "ok");
  const watch2 = createIdleWatch({idleHangMs: 0, pid: 123456789, now: t0});
  check("A: idle_hang_ms 0 never trips", evaluateIdleWatch(watch2, {now: t0 + 3600000}).status === "ok");
}

// First-output deadline: shorter limit until the first output byte.
{
  const t0 = 5000000;
  const mk = () => createIdleWatch({idleHangMs: 10000, firstOutputMs: 3000, pid: process.pid, now: t0});
  const w1 = mk();
  check("F: no output, before the first-output deadline is ok", evaluateIdleWatch(w1, {now: t0 + 2999}).status === "ok");
  const v1 = evaluateIdleWatch(w1, {now: t0 + 3000});
  check("F: no output at the first-output deadline is hung with noOutput", v1.status === "hung" && v1.noOutput === true, v1);
  const w2 = mk();
  noteIdleOutput(w2, t0 + 1000);
  check("F: after output the normal idle limit applies (still ok past first-output window)",
    evaluateIdleWatch(w2, {now: t0 + 1000 + 3000}).status === "ok");
  const v2 = evaluateIdleWatch(w2, {now: t0 + 1000 + 10000});
  check("F: after output, hang at the normal limit reports noOutput false", v2.status === "hung" && v2.noOutput === false, v2);
  const w3 = createIdleWatch({idleHangMs: 10000, firstOutputMs: 0, pid: process.pid, now: t0});
  check("F: firstOutputMs 0 disables the shorter limit", evaluateIdleWatch(w3, {now: t0 + 9999}).status === "ok");
  const w4 = createIdleWatch({idleHangMs: 10000, firstOutputMs: 50000, pid: process.pid, now: t0});
  check("F: firstOutputMs above idleHangMs is clamped to it", evaluateIdleWatch(w4, {now: t0 + 10000}).status === "hung");
  check("F: resolveFirstOutputMs default 180000, clamped, 0 off",
    resolveFirstOutputMs({}, 600000) === 180000 && resolveFirstOutputMs({}, 60000) === 60000
    && resolveFirstOutputMs({first_output_ms: 0}, 600000) === 0 && resolveFirstOutputMs({first_output_ms: 90000}, 600000) === 90000
    && resolveFirstOutputMs({}, 0) === 0 && resolveFirstOutputMs({first_output_ms: -5}, 600000) === 180000);
  check("F: validation rejects a bad first_output_ms",
    validatePolicyConfig({policy: {first_output_ms: -1}}) !== undefined);
}

// Single-hit + silence confirmation (injected 1-hit / 1s window).
{
  const t0 = 2000000;
  const gap = 1000;
  const watch = createIdleWatch({adapter: "opencode", idleHangMs: 60000, rateLimitMatches: 1, rateLimitGapMs: gap, now: t0});
  noteIdleStderrText(watch, RL_HIT, t0);
  check("A: single hit + silence just before the gap is ok",
    evaluateIdleWatch(watch, {now: t0 + gap - 1}).status === "ok");
  const verdict = evaluateIdleWatch(watch, {now: t0 + gap});
  check("A: single hit + silence at the gap confirms rate_limited with provider/model",
    verdict.status === "rate_limited" && verdict.provider === "opencode" && verdict.model === "muse-spark-1.3-contributor-free", verdict);
}

{
  const t0 = 3000000;
  const gap = 1000;
  const watch = createIdleWatch({adapter: "opencode", idleHangMs: 60000, rateLimitMatches: 1, rateLimitGapMs: gap, now: t0});
  noteIdleStderrText(watch, RL_HIT, t0);
  noteIdleOutput(watch, t0 + 10);
  check("A: output after a hit clears the pending rate-limit suspicion",
    watch.rateLimitFirstAt === null && watch.rateLimitHits === 0 && watch.rateLimitDetail === null,
    {rateLimitFirstAt: watch.rateLimitFirstAt, rateLimitHits: watch.rateLimitHits, rateLimitDetail: watch.rateLimitDetail});
  check("A: output after a hit stays ok past the gap",
    evaluateIdleWatch(watch, {now: t0 + 10 + gap}).status === "ok");
}

// ===========================================================================
// Part B: behavioral session harness (mirrors the runRelay wiring).
// ===========================================================================
function killTreeSync(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const end = Date.now() + 2000;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    if (!alive()) return;
    try { Atomics.wait(sleepBuf, 0, 0, 100); } catch { break; }
  }
  if (IS_WIN) {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {stdio: "ignore", shell: false, timeout: 10000}); } catch { /* best-effort */ }
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

// Drives one fake-adapter session through the same signal flow runRelay
// uses: every chunk -> noteIdleOutput (+ opencode stderr fast path), one
// evaluateIdleWatch per tick, SIGTERM then SIGKILL after the production
// grace on a trip.
async function runWatchSession({
  adapterFile, env = {}, idleHangMs = 3000, adapter = "fake",
  repoRoot, scratchDir = null, opencodeLogBase = null, logPrivate = false,
  tickMs = 250, timeoutMs = 30000, rateLimitGapMs = 1200, killGraceMs = IDLE_HANG_KILL_GRACE_MS,
}) {
  const child = spawn(process.execPath, [adapterFile], {
    cwd: repoRoot, env: {...process.env, ...env}, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  try { child.stdin.end(); } catch { /* nothing reads stdin */ }
  const startedAt = Date.now();
  const markers = [path.basename(adapterFile).toLowerCase()];
  const watch = idleHangMs > 0
    ? createIdleWatch({idleHangMs, pid: child.pid, adapter, adapterMarkers: markers, repoRoot, scratchDir, opencodeLogBase, logPrivate, rateLimitGapMs, startedAtMs: startedAt})
    : null;
  let stdout = "", stderr = "";
  if (child.stdout) child.stdout.on("data", d => {
    stdout += d;
    if (watch) {
      try {
        noteIdleOutput(watch);
        // Mirrors the runRelay wiring (backlog #36): the role's own
        // session id is captured live from its stdout events.
        if (adapter === "opencode" && !watch.sessionId) {
          const sid = extractSessionIdFromChunk(String(d));
          if (sid) noteIdleSessionId(watch, sid);
        }
      } catch { /* best-effort */ }
    }
  });
  if (child.stderr) child.stderr.on("data", d => {
    stderr += d;
    if (watch) {
      try {
        noteIdleOutput(watch);
        if (adapter === "opencode") noteIdleStderrText(watch, String(d));
      } catch { /* best-effort */ }
    }
  });
  let breach = null;
  let status = null, signal = null, timedOut = false;
  const t0 = Date.now();
  let graceTimer = null;
  await new Promise(resolve => {
    let settled = false;
    const timer = setInterval(() => {
      if (settled) return;
      if (watch && !breach) {
        let verdict = null;
        try { verdict = evaluateIdleWatch(watch); } catch { /* best-effort */ }
        if (verdict && verdict.status !== "ok") {
          breach = {...verdict, at: Date.now() - t0};
          try { child.kill("SIGTERM"); } catch { /* already gone */ }
          graceTimer = setTimeout(() => {
            if (settled) return;
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            if (IS_WIN) {
              try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {stdio: "ignore", shell: false, timeout: 10000}); } catch { /* best-effort */ }
            }
          }, killGraceMs);
        }
      }
      if (Date.now() - t0 > timeoutMs && !settled) {
        settled = true;
        timedOut = true;
        clearInterval(timer);
        resolve();
      }
    }, tickMs);
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      status = code;
      signal = sig;
      clearInterval(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve();
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve();
    });
  });
  if (timedOut || status === null) killTreeSync(child.pid);
  return {breach, elapsedMs: Date.now() - t0, status, signal, stdout, stderr, timedOut, pid: child.pid};
}

function makeRepoRoot() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-sess-"));
  fs.writeFileSync(path.join(repo, "probe.txt"), "v1");
  return repo;
}

function makeAdapterDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-ad-"));
}

const SILENT_HANG_CODE = "setTimeout(()=>{},60000);";
// Load-robust margins (backlog #13): under heavy parallel load node startup
// of the adapter + the child spawn can take several seconds, and the idle
// clock starts before that. With a 3 s window the watchdog could tick before
// the child existed and (correctly) trip. A 9 s window leaves a wide margin
// for startup, and the child outlives it (12 s) so the check still proves a
// live child, not the clock, keeps the session alive.
const CHILD_CASE_IDLE_MS = 9000;
const CHILD_CASE_CHILD_MS = 12000;
const CHILD_WORK_CODE = [
  'const {spawn} = require("node:child_process");',
  `const kid = spawn(process.execPath, ["-e", "setTimeout(()=>{},${CHILD_CASE_CHILD_MS});"], {shell:false, stdio:"ignore"});`,
  'kid.on("exit", () => process.exit(0));',
  "setTimeout(() => process.exit(3), 25000);",
  "",
].join("\n");
const SILENT_EXIT_4S_CODE = "setTimeout(()=>{process.exit(0);},4000);";
// Output lands 1.5s in, then silence: the trip must measure from the last
// output (~4.5s), proving the clock reset (a start-based clock would fire
// at ~3s).
const OUTPUT_THEN_SILENCE_CODE = "setTimeout(()=>{process.stdout.write(\"working\\n\");},1500); setTimeout(()=>{},60000);";

// Case 1: silent, no child, no writes -> killed at about idle_hang_ms.
{
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  try {
    const r = await runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", SILENT_HANG_CODE), repoRoot: repo});
    check("1: silent hang is killed (breach hung)", r.breach?.status === "hung", r.breach);
    check("1: killed at about idle_hang_ms (not instantly, not at the 60-min deadline)",
      r.elapsedMs >= 2800 && r.elapsedMs < 15000, r.elapsedMs);
    check("1: the session process is actually dead", (() => {
      try { process.kill(r.pid, 0); return false; } catch { return true; }
    })(), r.pid);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Case 2: silent, but a live child outlives the window -> NOT killed.
{
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  try {
    const r = await runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", CHILD_WORK_CODE), repoRoot: repo, idleHangMs: CHILD_CASE_IDLE_MS, timeoutMs: 40000});
    check("2: session with a live child is not tripped", r.breach === null, r.breach);
    check("2: it finishes normally once the child is done", r.status === 0, {status: r.status, signal: r.signal});
    check("2: it outlived the idle window (the child, not the watchdog, set the pace)",
      r.elapsedMs >= CHILD_CASE_CHILD_MS - 200 && r.elapsedMs < 25000, r.elapsedMs);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Case 3: silent, but writing a file every second -> not killed.
{
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const beat = path.join(repo, "heartbeat.txt");
  try {
    const code = [
      "let n = 0;",
      `const beatPath = ${JSON.stringify(beat)};`,
      'const t = setInterval(() => { require("node:fs").appendFileSync(beatPath, "beat " + (n++) + "\\n"); if (n >= 6) { clearInterval(t); process.exit(0); } }, 800);',
      "",
    ].join("\n");
    const r = await runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", code), repoRoot: repo, timeoutMs: 20000});
    check("3: steady file writes reset the clock (no trip)", r.breach === null, r.breach);
    check("3: exits normally", r.status === 0, r.status);
    check("3: the writes really happened", fs.readFileSync(beat, "utf8").split("\n").filter(Boolean).length >= 4);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Case 4: output every second -> not killed.
{
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  try {
    const code = [
      "let n = 0;",
      'const t = setInterval(() => { process.stdout.write("still here " + (n++) + "\\n"); if (n >= 6) { clearInterval(t); process.exit(0); } }, 800);',
      "",
    ].join("\n");
    const r = await runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", code), repoRoot: repo, timeoutMs: 20000});
    check("4: steady output resets the clock (no trip)", r.breach === null, r.breach);
    check("4: exits normally", r.status === 0 && r.stdout.split("\n").filter(Boolean).length >= 4, r.status);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Case 5: output, then silence with no child -> killed about idle_hang_ms
// after the LAST output (the clock resets).
{
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  try {
    const r = await runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", OUTPUT_THEN_SILENCE_CODE), repoRoot: repo});
    check("5: output-then-silence is killed (breach hung)", r.breach?.status === "hung", r.breach);
    check("5: killed ~idle_hang_ms after the last output, not after start",
      r.elapsedMs >= 4200 && r.elapsedMs < 15000, r.elapsedMs);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Case 6: idle_hang_ms 0 -> watchdog off.
{
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  try {
    const r = await runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", SILENT_EXIT_4S_CODE), repoRoot: repo, idleHangMs: 0, timeoutMs: 20000});
    check("6: watchdog off means a silent session is never tripped", r.breach === null, r.breach);
    check("6: exits normally", r.status === 0, r.status);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Case 7: config validation (mirrored in test-config-validation.mjs).
{
  check("7: negative rejected", validatePolicyConfig({idle_hang_ms: -1}).valid === false);
  check("7: non-integer rejected", validatePolicyConfig({idle_hang_ms: 3000.5}).valid === false);
  check("7: non-number rejected", validatePolicyConfig({idle_hang_ms: "3000"}).valid === false);
  const over = validatePolicyConfig({idle_hang_ms: 30 * 60 * 1000, per_task_timeout_ms: 30 * 60 * 1000});
  check("7: at/above the per-task deadline rejected with a clear error",
    over.valid === false && over.errors.some(e => e.includes("idle_hang_ms") && e.includes("per_task_timeout_ms")), over.errors);
  const overDefault = validatePolicyConfig({idle_hang_ms: 61 * 60 * 1000});
  check("7: above the effective default deadline rejected too",
    overDefault.valid === false && overDefault.errors.some(e => e.includes("idle_hang_ms")), overDefault.errors);
  check("7: 0 (off) accepted", validatePolicyConfig({idle_hang_ms: 0}).valid === true);
  check("7: absent accepted (code default)", validatePolicyConfig({}).valid === true);
  check("7: fitting value accepted",
    validatePolicyConfig({idle_hang_ms: 3000}).valid === true
    && validatePolicyConfig({idle_hang_ms: 600000, per_task_timeout_ms: 30 * 60 * 1000}).valid === true);
}

// Case 8: rate limits. Log lines carry a FRESH timestamp (the module's
// rotation guard rejects pre-session lines — covered explicitly below).
const RL_LINE = m => `timestamp=${new Date().toISOString()} level=ERROR message="stream error" providerID=opencode modelID=${m} error.error="AI_APICallError: Upstream request failed: [rate_limit_exceeded] Rate limit exceeded. Please retry after a brief wait."`;
// Backlog #36: same shape but attributed to a log session.
const RL_LINE_SID = (m, sid) => `timestamp=${new Date().toISOString()} level=ERROR message="stream error" providerID=opencode modelID=${m} session.id=${sid} error.error="AI_APICallError: Upstream request failed: [rate_limit_exceeded] Rate limit exceeded. Please retry after a brief wait."`;
// Emits this session's own sessionID event from the fake adapter, so the
// harness (like runRelay's onChunk) can capture it.
function sessionEmitCode(id, delayMs = 0) {
  const stmt = `process.stdout.write(${JSON.stringify(`${JSON.stringify({type: "step_start", sessionID: id})}\n`)});`;
  return delayMs ? `setTimeout(()=>{${stmt}},${delayMs});` : stmt;
}
{
  // Backlog #36: one hit for THIS session.id on the shared log, then
  // rateLimitGapMs of silence, trips RATE_LIMITED (single-hit rule).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const OURS = "ses_case8a_ours";
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "timestamp=2026-10-02T09:00:00.000Z level=INFO message=boot\n");
    const code = `${sessionEmitCode(OURS)}${SILENT_HANG_CODE}`;
    // Session emit lands in the first second (adapter startup); the hit
    // waits past it so it counts (a hit before the id is known
    // is ignored by design — case 8g pins that).
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-case8a.cjs", code), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, idleHangMs: 8000, rateLimitGapMs: 1200});
    await new Promise(r => setTimeout(r, 1200));
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE_SID("opencode/muse-spark", OURS) + "\n");
    // No second hit: silence for rateLimitGapMs (1200 ms) confirms it.
    const r = await p;
    check("8: single log hit + silence trips RATE_LIMITED", r.breach?.status === "rate_limited", r.breach);
    check("8: provider/model are extracted", r.breach?.provider === "opencode" && r.breach?.model === "opencode/muse-spark", r.breach);
    check("8: fast (well inside the old 60-min wait)", r.elapsedMs < 15000, r.elapsedMs);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}
{
  // A single matching line for this session followed by normal output ->
  // spared (output after the hit cancels the pending confirmation).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const OURS = "ses_case8b_ours";
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "");
    const code = [
      sessionEmitCode(OURS),
      "let n = 0;",
      'const t = setInterval(() => { process.stdout.write("progress " + (n++) + "\\n"); if (n >= 6) { clearInterval(t); process.exit(0); } }, 800);',
      "",
    ].join("\n");
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-case8b.cjs", code), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, rateLimitGapMs: 1200, timeoutMs: 20000});
    await new Promise(r => setTimeout(r, 1200));
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE_SID("opencode/m", OURS) + "\n");
    const r = await p;
    check("8: single hit + normal output is spared", r.breach === null && r.status === 0, {breach: r.breach, status: r.status});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}
{
  // Backlog #36: on the SHARED log, unattributed lines never count — even
  // with our session id known a fresh hit stays ignored (single-hit rule).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const OURS = "ses_case8d_ours";
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "");
    const code = `${sessionEmitCode(OURS)}${SILENT_EXIT_4S_CODE}`;
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-case8d.cjs", code), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, idleHangMs: 8000, rateLimitGapMs: 500, timeoutMs: 20000});
    await new Promise(r => setTimeout(r, 1200));
    // Single hit suffices under the single-hit rule: had it counted, 500ms
    // of silence would confirm well before the 4s adapter exit.
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE("opencode/m") + "\n");
    const r = await p;
    check("8: shared log + unattributed lines are ignored (id known)", r.breach === null && r.status === 0, {breach: r.breach, status: r.status});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}
{
  // Backlog #36: the false positive itself — a CONCURRENT foreign session's
  // rate-limit storm on the shared log must not kill our role.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const OURS = "ses_case8e_ours";
  const FOREIGN = "ses_case8e_operator_hand_session";
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "");
    const code = `${sessionEmitCode(OURS)}${SILENT_EXIT_4S_CODE}`;
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-case8e.cjs", code), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, idleHangMs: 8000, rateLimitGapMs: 500, timeoutMs: 20000});
    await new Promise(r => setTimeout(r, 1200));
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE_SID("opencode/m", FOREIGN) + "\n");
    await new Promise(r => setTimeout(r, 800));
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE_SID("opencode/m", FOREIGN) + "\n");
    const r = await p;
    check("8: foreign session.id storm on the shared log is ignored", r.breach === null && r.status === 0, {breach: r.breach, status: r.status});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}
{
  // Backlog #36: hits that arrive BEFORE our session id is known are never
  // counted (no retroactive confirmation once it arrives).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const OURS = "ses_case8g_ours";
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "");
    const code = `${sessionEmitCode(OURS, 2500)}${SILENT_EXIT_4S_CODE}`;
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-case8g.cjs", code), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, idleHangMs: 8000, rateLimitGapMs: 500, timeoutMs: 20000});
    await new Promise(r => setTimeout(r, 300));
    // One pre-known-id hit + ample silence still never confirms
    // (single-hit rule: no retroactive confirmation once the id arrives).
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE_SID("opencode/m", OURS) + "\n");
    const r = await p;
    check("8: pre-known-id hits never confirm", r.breach === null && r.status === 0, {breach: r.breach, status: r.status});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}
{
  // Backlog #36: the implementer's bound store is private to the session,
  // so a single unattributed line still counts there once our id is known
  // (single-hit rule: one hit + rateLimitGapMs of silence confirms).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  const OURS = "ses_case8h_ours";
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "");
    const code = `${sessionEmitCode(OURS)}${SILENT_HANG_CODE}`;
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-case8h.cjs", code), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, logPrivate: true, idleHangMs: 8000, rateLimitGapMs: 1200});
    await new Promise(r => setTimeout(r, 1200));
    fs.appendFileSync(path.join(home, "log", "opencode.log"), RL_LINE("opencode/muse-spark") + "\n");
    // No second hit: silence for rateLimitGapMs (1200 ms) confirms it.
    const r = await p;
    check("8: bound store + single unattributed line still trips RATE_LIMITED", r.breach?.status === "rate_limited", r.breach);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}
{
  // Stale (pre-session) lines never count, even when they arrive AFTER the
  // offset baseline (the rotation case: the baseline is lost, so the
  // timestamp guard is what rejects them). A single old-dated hit must not
  // confirm (single-hit rule).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-home-"));
  const repo = makeRepoRoot();
  const addir = makeAdapterDir();
  try {
    fs.mkdirSync(path.join(home, "log"), {recursive: true});
    fs.writeFileSync(path.join(home, "log", "opencode.log"), "");
    const stale = "timestamp=2020-01-01T00:00:00.000Z level=ERROR providerID=opencode modelID=m error.error=\"AI_APICallError: x [rate_limit_exceeded] Rate limit exceeded.\"";
    const p = runWatchSession({adapterFile: writeAdapterFile(addir, "fake-adapter-.cjs", SILENT_EXIT_4S_CODE), repoRoot: repo, adapter: "opencode", opencodeLogBase: home, idleHangMs: 8000, rateLimitGapMs: 500, timeoutMs: 20000});
    await new Promise(r => setTimeout(r, 300));
    fs.appendFileSync(path.join(home, "log", "opencode.log"), `${stale}\n`);
    const r = await p;
    check("8: pre-session lines never confirm (rotation-safe)", r.breach === null && r.status === 0, {breach: r.breach, status: r.status});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(addir, {recursive: true, force: true});
  }
}

// Static wiring checks: the relay integration in the single shared site.
{
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("wire: idle limit resolved against the session bound",
    /const idleHangMs=resolveIdleHangMs\(c\.policy, relayTimeoutMs\);/.test(src));
  check("wire: watch armed in onStart with repo/scratch/log inputs",
    /createIdleWatch\(\{idleHangMs,firstOutputMs,maxSilenceMs,pid,adapter:role\.adapter,adapterMarkers:idleAdapterMarkers,repoRoot:effectiveCwd,scratchDir:effectiveScratchDir,opencodeLogBase,opencodeLogFallbackBase,logPrivate:opencodeLogPrivate\}\)/.test(src));
  check("wire: log privacy follows the base (bound store private, HOME fallback shared)",
    /if\(hostDir\) return \{base: hostDir, priv: true\};/.test(src)
    && /if\(fs\.existsSync\(candidate\)\) return \{base: candidate, priv: false\};/.test(src));
  check("wire: session id captured live from opencode stdout events (first wins)",
    /if\(role\.adapter==="opencode"&&stream==="stdout"&&!idleWatch\.sessionId\)\{\s*\n\s*const sid=extractSessionIdFromChunk\(String\(chunk\)\);\s*\n\s*if\(sid\) noteIdleSessionId\(idleWatch,sid\);/.test(src));
  check("wire: chain marker derived from the launch binary (never the adapter id)",
    /const idleAdapterMarkers=\(\(\)=>\{/.test(src) && /adapterMarkerFor\(launchBinary, launchArgs\)/.test(src));
  check("wire: every chunk resets the clock (onChunk)",
    /noteIdleOutput\(idleWatch\);/.test(src)
    && /if\(role\.adapter==="opencode"&&stream==="stderr"\) noteIdleStderrText\(idleWatch,String\(chunk\)\);/.test(src));
  check("wire: 1s tick evaluates the watchdog next to the caps",
    /capTimer=setInterval\(\(\)=>\{ try\{ evaluateCaps\(\); \}catch\{\} try\{ evaluateIdle\(\); \}catch\{\} \},1000\);/.test(src));
  check("wire: trip kills like the cap/deadline path (SIGTERM, SIGKILL after grace)",
    /process\.kill\(capPid,"SIGTERM"\); \}catch\{\}\s*\n\s*idleKillTimer=setTimeout\(\(\)=>\{ if\(!capSettled&&capPid!=null\)\{ try\{ process\.kill\(capPid,"SIGKILL"\);/.test(src)
    && /IDLE_HANG_KILL_GRACE_MS/.test(src));
  check("wire: hung trip classifies IDLE_HANG/infrastructure/retryable with the naming message",
    /result\.failure=failure\("IDLE_HANG","infrastructure",true,/.test(src)
    && /formatIdleHangMessage\(\{role:roleName,adapter:role\.adapter,model:role\.model\|\|null,idleMs:idleBreach\.idleMs,maxSilence:idleBreach\.maxSilence===true\}\)/.test(src));
  check("wire: rate-limit trip reuses RATE_LIMITED/infrastructure/non-retryable",
    /result\.failure=failure\("RATE_LIMITED","infrastructure",false,/.test(src));
  check("wire: trip observed on the run record",
    /IDLE_HANG \| ROLE=/.test(src) && /RATE_LIMITED \| ROLE=/.test(src));
  check("wire: single shared site for both loops (twin-loop comment)",
    /SINGLE shared site for both loops/.test(src));
  check("wire: watchdog state settles in finally (no pid-reuse kill)",
    /if\(idleKillTimer\)\{clearTimeout\(idleKillTimer\);idleKillTimer=null;\}/.test(src));
}

if (IS_WIN) {
  console.log("test-idle-hang-watchdog: Part C SKIP — the twin-loop relay proof runs real missions inside the Linux/WSL sandbox envelope.");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("test-idle-hang-watchdog: unit + behavioral checks PASSED (Part C skipped on this platform)");
  process.exit(0);
}

// ===========================================================================
// Part C: twin-loop proof — one standalone + one SpecKit REAL mission with
// a silently-hanging fake adapter; each must record IDLE_HANG.
// ===========================================================================
function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", stdio: "pipe", shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

const FAKE_ADAPTER = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("fake-idle-hang-adapter 1.0.0\\n"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { stdin += c; });
process.stdin.on("end", () => {
  const first = (stdin.trimStart().split(/\\r?\\n/, 1)[0] || "");
  const role = first.startsWith("ROLE=") ? first.slice("ROLE=".length).trim() : "";
  // The mission-024 shape: everything passes instantly EXCEPT the
  // implementer, which hangs silently (no output, no child, no writes)
  // until the watchdog ends it.
  if (role === "implementer") { setTimeout(() => {}, 60000); return; }
  if (role === "planner") {
    // SpecKit staged shape ("Planning phase: <step>."): write the real
    // contracts from observable filesystem state (same protocol as
    // test-fixtures/fake-workflow-adapter.sh).
    const stepMatch = stdin.match(/^Planning phase: (.*)\\.$/m);
    if (stepMatch) {
      const FEATURE = "001-idle-hang";
      const step = stepMatch[1].trim();
      if (step === "specify") {
        fs.mkdirSync(".specify", {recursive: true});
        fs.writeFileSync(path.join(".specify", "feature.json"), JSON.stringify({feature_directory: "specs/" + FEATURE}));
        fs.mkdirSync(path.join("specs", FEATURE), {recursive: true});
        fs.writeFileSync(path.join("specs", FEATURE, "spec.md"), "# Spec\\n\\nIdle-hang fixture feature.\\n");
      } else if (step === "plan") {
        fs.writeFileSync(path.join("specs", FEATURE, "plan.md"), "# Plan\\n\\nIdle-hang fixture plan.\\n");
        try {
          if (fs.existsSync("CLAUDE.md")) {
            const cur = fs.readFileSync("CLAUDE.md", "utf8");
            const b = "<!-- SPECKIT START -->"; const e = "<!-- SPECKIT END -->";
            const bi = cur.indexOf(b); const ei = cur.indexOf(e);
            if (bi !== -1 && ei !== -1 && ei > bi) {
              fs.writeFileSync("CLAUDE.md", cur.slice(0, bi + b.length) + "\\nActive feature: " + FEATURE + "\\n" + cur.slice(ei));
            }
          }
        } catch {}
      } else if (step === "tasks") {
        fs.writeFileSync(path.join("specs", FEATURE, "tasks.md"), "## Phase 1: Do the fixture task\\n\\n- [ ] Do the fixture task\\n");
      } else { process.stderr.write("fake: unknown planning step " + step + "\\n"); process.exit(1); }
      process.stdout.write("planner ok " + step + "\\n");
      process.exit(0);
    }
    // Standalone shape: plan + phased checklist paths in the prompt.
    const planMatch = stdin.match(/Write the (?:narrative )?plan to exactly:\\s*(.*)/);
    const tasksMatch = stdin.match(/Write the phased checklist to exactly:\\s*(.*)/);
    const legacyMatch = !planMatch ? stdin.match(/Write the plan to exactly:\\s*(.*)/) : null;
    const planPath = planMatch ? planMatch[1].trim() : legacyMatch ? legacyMatch[1].trim() : null;
    if (!planPath) { process.stderr.write("fake: no plan path\\n"); process.exit(1); }
    if (tasksMatch) {
      const tasksPath = tasksMatch[1].trim();
      fs.writeFileSync(planPath, "# Plan\\n\\nObjective: add a fixture line to README.md\\n\\nScope: single line.\\n");
      fs.writeFileSync(tasksPath, "## Phase 1: General\\n\\n- [ ] 1. Add a fixture line to README.md \\u2014 accept: line added ; verify: check README.md\\n");
    } else {
      fs.writeFileSync(planPath, "# Plan\\n\\n## Checklist\\n\\n- [ ] 1. Add a fixture line to README.md\\n\\nVerification: manual.\\n");
    }
    process.stdout.write("Wrote the plan.\\n");
    process.exit(0);
  }
  // Every reviewer/verifier: instant PASS (gates and reviews alike).
  process.stdout.write("Reviewed.\\nAUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []}) + "\\n");
  process.exit(0);
});
`;

function makeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-bin-"));
  const target = path.join(binDir, "cursor-agent");
  fs.writeFileSync(target, FAKE_ADAPTER);
  fs.chmodSync(target, 0o755);
  return binDir;
}

const SPECKIT_WORKFLOW_YML = [
  "- id: specify",
  "  type: command",
  "  command: /speckit.specify",
  "- id: review-spec",
  "  type: gate",
  "  message: Review the spec",
  "- id: plan",
  "  type: command",
  "  command: /speckit.plan",
  "- id: review-plan",
  "  type: gate",
  "  message: Review the plan",
  "- id: tasks",
  "  type: command",
  "  command: /speckit.tasks",
  "- id: review-tasks",
  "  type: gate",
  "  message: Review the tasks",
  "- id: implement",
  "  type: command",
  "  command: /speckit.implement",
  ""
].join("\n");

function makeRepo(framework) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-idle-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "idle-test@example.invalid"]);
  git(repo, ["config", "user.name", "Idle Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  if (framework === "speckit") {
    // Proven minimal SpecKit starting point (same shape as
    // test-windows-full-speckit-workflow.mjs): NO pre-existing feature —
    // planning creates it. Pre-created tasks.md WITHOUT .specify/feature.json
    // fails feature resolution (feature_json_missing), so it must NOT exist.
    const wfDir = path.join(repo, ".specify", "workflows", "speckit");
    fs.mkdirSync(wfDir, {recursive: true});
    fs.writeFileSync(path.join(wfDir, "workflow.yml"), SPECKIT_WORKFLOW_YML);
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), [
      "# CLAUDE.md", "", "Project instructions (outside the Autopilot-controlled section).", "",
      "<!-- SPECKIT START -->", "(no active SpecKit feature)", "<!-- SPECKIT END -->", "", "More project instructions.", ""
    ].join("\n"));
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function writeIdleConfig(repo, framework) {
  const role = {adapter: "cursor", model: "", reasoning: "", variant: "", resume: false, model_source: "default", model_verified_at: null, capabilities_verified_at: null};
  const config = {
    schema_version: "3.0",
    project: {repo: ".", planning_framework: framework, state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {planner: role, plan_reviewer: role, implementer: role, code_reviewer: role, verifier: role},
    workflow: {
      specReview: true, planReview: true, analysisAfterTasks: true, implementationReview: true, finalReview: true,
      autoApproveSpec: false, autoApprovePlan: false, parallelIndependentTasks: false, gsdPlanningReview: false,
      relaySafety: {block_git_commit_push: true, verify_read_only_by_snapshot: true, capture_touched_files: true, persist_role_sessions: true}
    },
    gates: {commands: [], env_allowlist: [], require_reviewer: true, network_isolation: true},
    policy: {
      max_plan_revisions: 1, retry_delay_ms: 0, checkpoint_after_task: true, checkpoint_after_phase: true,
      require_human_commit: true, fail_closed_on_relay_violation: true, idle_hang_ms: 3000,
      failure_budgets: {implementationFailureBudget: 1, verificationFailureBudget: 1, adapterRetryBudget: 1, infrastructureRetryBudget: 1}
    },
    safety: {allow_git_commit: false, allow_git_push: false, allow_destructive_operations: false},
    planning: {
      speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_candidates: ["specs/*/tasks.md", ".specify/tasks.md"]},
      gsd: {phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: false, parallelization: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 1, min_plans_for_parallel: 99}, planning_review: {enabled: false, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}}
    },
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}
  };
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
}

function findResultJsons(repo) {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === "result.json") out.push(p);
    }
  };
  walk(path.join(repo, ".autopilot"));
  return out;
}

async function runTwinMission(framework) {
  const repo = makeRepo(framework);
  const binDir = makeBin();
  try {
    writeIdleConfig(repo, framework);
    // Strip any outer mission/gate git guard (PATH shim + hooks): the nested
    // mission installs its own, and running every git call through both made
    // this mission ~4x slower under the orchestrator gate (same as the
    // workflow-order harness does).
    const base = withoutOuterGitGuard({...process.env});
    const env = {...base, PATH: `${binDir}:${base.PATH || ""}`};
    const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "add a fixture line to README.md", "--repo", repo], {
      cwd: repo, encoding: "utf8", env, timeout: 240000, stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    check(`${framework}: hanging mission escalates (nonzero exit)`, run.status !== 0,
      {status: run.status, stderr: (run.stderr || "").slice(-300)});
    const idleResults = [];
    for (const file of findResultJsons(repo)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed?.failure?.class === "IDLE_HANG") idleResults.push({file: path.relative(repo, file), failure: parsed.failure, role: parsed.role || null});
      } catch { /* unreadable run record: ignore */ }
    }
    check(`${framework}: at least one run records IDLE_HANG`, idleResults.length >= 1,
      {resultFiles: findResultJsons(repo).map(f => path.relative(repo, f)).slice(0, 10)});
    const first = idleResults[0]?.failure;
    if (check(`${framework}: IDLE_HANG is infrastructure + retryable`, first?.domain === "infrastructure" && first?.retryable === true, first)) {
      const msg = first?.evidence?.find(e => e?.source === "relay")?.message || "";
      check(`${framework}: message names the hang (no output, no command, no file)`,
        msg.includes("produced no output, ran no command and wrote no file"), msg);
      check(`${framework}: the hung session is the implementer (the mission-024 shape)`,
        idleResults.some(r => r.role === "implementer"), idleResults.map(r => r.role));
    }
    let budgets = {};
    try {
      budgets = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")).failureBudgets || {};
    } catch { /* state may be absent on some paths */ }
    check(`${framework}: infrastructure budget recorded the hang`,
      Object.entries(budgets).some(([k, v]) => k.startsWith("infrastructureRetryBudget") && v >= 1), budgets);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

await runTwinMission("standalone");
await runTwinMission("speckit");

if (failures) {
  console.error(`${failures} idle-hang-watchdog check(s) failed.`);
  process.exit(1);
}
console.log("test-idle-hang-watchdog: ALL CHECKS PASSED");
