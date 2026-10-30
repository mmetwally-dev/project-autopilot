#!/usr/bin/env node
// Backlog #104: the idle watchdog must also catch a silent read-only review
// role (verifier). Root causes covered: (2) a run with zero output was kept
// alive by a live descendant (sandbox wrapper / unmatched adapter launcher);
// (1) a long tool child suspended the idle clock indefinitely -> absolute
// max-silence cap (policy.max_silence_ms, default 15 min).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {createIdleWatch, evaluateIdleWatch, noteIdleOutput, isChainCommand, formatIdleHangMessage} from "./idle-hang-watchdog.mjs";
import {resolveMaxSilenceMs, resolveFirstOutputMs} from "./per-task-budget.mjs";
import {validatePolicyConfig} from "./config-validation.mjs";

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`PASS ${name}`); return; }
  failures += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-review-"));
const repo = path.join(dir, "repo"); fs.mkdirSync(repo);

function adapterFile(name, body) { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; }

// Fake read-only adapter. No marker is passed for it, so a live child of the
// adapter looks like "tool work" exactly like the sandboxed opencode did.
async function run(file, {idleHangMs, firstOutputMs, maxSilenceMs = 0, timeoutMs = 15000, startAfterFirstOutput = false}) {
  const child = spawn(process.execPath, [file], {cwd: repo, stdio: ["ignore", "pipe", "pipe"]});
  const t0 = Date.now();
  let watch = null;
  let firstOutputSeen = false;
  let resolveFirstOutput;
  const firstOutput = new Promise(resolve => { resolveFirstOutput = resolve; });
  const onData = () => {
    if (!firstOutputSeen) { firstOutputSeen = true; resolveFirstOutput(); }
    if (watch) noteIdleOutput(watch);
  };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  const closed = new Promise(resolve => child.on("close", resolve));
  if (startAfterFirstOutput) {
    // Under CPU load the child's first byte can take longer than the
    // first-output window. B/C test the idle/cap clocks, so arm them only
    // once the child has actually spoken (bounded by the case timeout).
    let waitTimer;
    await Promise.race([
      firstOutput,
      closed,
      new Promise(resolve => { waitTimer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(waitTimer);
  }
  watch = createIdleWatch({idleHangMs, firstOutputMs, maxSilenceMs, pid: child.pid, adapter: "opencode", repoRoot: repo});
  if (firstOutputSeen) noteIdleOutput(watch);
  const watchStart = Date.now();
  let breach = null;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const timer = setInterval(() => {
        const v = evaluateIdleWatch(watch);
        // Timed against the watchdog window so a slow first byte (spawn +
        // node startup under load) cannot stretch the idle/cap assertions.
        if (v.status !== "ok" && !breach) { breach = {...v, at: Date.now() - watchStart}; child.kill("SIGKILL"); }
        if (Date.now() - watchStart > timeoutMs) { child.kill("SIGKILL"); }
      }, 200);
      closed.then(() => { clearInterval(timer); resolve(); });
    });
  }
  return {breach, elapsed: Date.now() - t0};
}

// A: verifier emits nothing (while a child process of it is alive) -> noOutput hang at the first-output limit.
const silent = adapterFile("silent.mjs", `import {spawn} from "node:child_process"; spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"}); setTimeout(()=>{},60000);`);
const a = await run(silent, {idleHangMs: 8000, firstOutputMs: 1500});
check("A: silent verifier -> IDLE_HANG noOutput near first-output limit",
  a.breach?.status === "hung" && a.breach.noOutput === true && a.breach.at >= 1400 && a.breach.at < 4500, JSON.stringify(a));

// B: emits once, short child, then silent -> hung after idle limit (child exit no longer suspends).
const shortChild = adapterFile("short.mjs", `import {spawn} from "node:child_process"; console.log("hello"); spawn(process.execPath,["-e","setTimeout(()=>{},500)"],{stdio:"ignore"}); setTimeout(()=>{},60000);`);
const b = await run(shortChild, {idleHangMs: 2000, firstOutputMs: 1000, maxSilenceMs: 0, startAfterFirstOutput: true});
check("B: emit, short child, silence -> hung after idle limit",
  b.breach?.status === "hung" && b.breach.noOutput === false && b.breach.at >= 1900 && b.breach.at < 6000, JSON.stringify(b));

// C: long-running child beyond the max-silence cap -> hung at the cap, not suspended.
const longChild = adapterFile("long.mjs", `import {spawn} from "node:child_process"; console.log("hello"); spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"}); setTimeout(()=>{},60000);`);
const c = await run(longChild, {idleHangMs: 1500, firstOutputMs: 1000, maxSilenceMs: 4000, startAfterFirstOutput: true});
check("C: long child beyond max-silence cap -> hung at the cap",
  c.breach?.status === "hung" && c.breach.maxSilence === true && c.breach.at >= 3900 && c.breach.at < 7000, JSON.stringify(c));

// C2: without a cap the same long child still suspends the watch (existing behaviour kept for write roles).
const c2 = await run(longChild, {idleHangMs: 1500, firstOutputMs: 1000, maxSilenceMs: 0, timeoutMs: 5000, startAfterFirstOutput: true});
check("C2: no cap -> live child keeps the session (not hung)", c2.breach === null, JSON.stringify(c2));

// D: resolvers and validation.
check("D: resolveMaxSilenceMs default 15 min, override, 0 off, idle off -> 0",
  resolveMaxSilenceMs({}, 600000) === 900000 && resolveMaxSilenceMs({max_silence_ms: 120000}, 60000) === 120000
  && resolveMaxSilenceMs({max_silence_ms: 0}, 600000) === 0 && resolveMaxSilenceMs({}, 0) === 0
  && resolveMaxSilenceMs({max_silence_ms: 1000}, 60000) === 60000 && resolveFirstOutputMs({}, 600000) === 180000);
check("D: validation rejects bad max_silence_ms",
  validatePolicyConfig({policy: {max_silence_ms: -1}}) !== undefined);

// D2: the default cap is derived from the role deadline (never shorter), so a long
// legitimate tool run inside the deadline is not killed; an explicit override is honored.
check("D2: default cap >= role deadline; explicit override honored",
  resolveMaxSilenceMs({}, 600000, 2400000) === 2400000 && resolveMaxSilenceMs({}, 600000, 300000) === 900000
  && resolveMaxSilenceMs({max_silence_ms: 120000}, 60000, 2400000) === 120000);
{
  const watch = createIdleWatch({idleHangMs: 1500, firstOutputMs: 1000, maxSilenceMs: resolveMaxSilenceMs({}, 1500, 3600000), pid: process.pid, adapter: "opencode", repoRoot: repo});
  const r = evaluateIdleWatch(watch, {now: Date.now() + 20 * 60 * 1000, hasLiveWork: () => true});
  check("D2: 20 min silence under a 60 min role deadline is not a max-silence hang", r.maxSilence !== true, JSON.stringify(r));
}
check("D2: max-silence message is distinct",
  /IDLE_HANG \(max silence\).*while a tool ran/.test(formatIdleHangMessage({role: "verifier", adapter: "opencode", model: "m", idleMs: 900000, maxSilence: true}))
  && !/ran no command/.test(formatIdleHangMessage({role: "verifier", adapter: "opencode", model: "m", idleMs: 900000, maxSilence: true})));

// D3: launcher markers match the launcher's argv[0] (or the script after a runtime), not any substring.
check("D3: tool child merely mentioning an adapter name is work",
  !isChainCommand("node /repo/scripts/test-agy-events.mjs", ["agy"]) && !isChainCommand("cat /home/u/.claude/x.txt", ["claude"])
  && !isChainCommand("python3 run_opencode_tests.py", ["opencode"]) && !isChainCommand("grep opencode file", ["opencode"]));
check("D3: real launchers still match",
  isChainCommand("/usr/local/bin/opencode run --model x", ["opencode"]) && isChainCommand("node /usr/lib/claude.js -p", ["claude.js"])
  && isChainCommand("cmd.exe /c opencode.cmd run", ["opencode"]) && isChainCommand("C:\\bin\\opencode.exe run", ["opencode"]));

// E: wiring is role independent and covers the sandbox wrapper.
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("E: relay wires maxSilenceMs for read-only roles and adds the transport marker",
  /maxSilenceMs=readOnly\?resolveMaxSilenceMs/.test(src) && /createIdleWatch\(\{idleHangMs,firstOutputMs,maxSilenceMs,/.test(src)
  && /invocation\?\.binary\) markers\.push/.test(src));

fs.rmSync(dir, {recursive: true, force: true});
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("all passed");
