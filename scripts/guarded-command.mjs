import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { networkIsolationPrefix, sandboxCommandPrefix, decideExecution, logShellDecision } from "./shell-guard.mjs";

export function runGuardedCommand(cwd, command, env, shellGuard, options = "unspecified") {
  const opts = typeof options === "string" ? { label: options } : (options || {});
  if (opts.capture === true) return runGuardedCommandCaptured(cwd, command, env, shellGuard, opts);
  return runGuardedCommandBuffered(cwd, command, env, shellGuard, opts);
}

// Decides how the command is spawned (sandbox / network isolation / plain
// shell) exactly as today, and returns either the ready-to-spawn plan or the
// blocked result. Shared by the buffered and the output-capturing executors
// so the sandbox/guard behavior is byte-identical for both.
function planExecution(cwd, command, shellGuard, opts) {
  const label = opts.label || "unspecified";
  const untrusted = opts.untrusted === true;
  const sandboxRequired = untrusted || opts.sandboxRequired === true;
  const netPrefix = networkIsolationPrefix();
  const sandboxPrefix = sandboxRequired ? sandboxCommandPrefix(cwd, { required: true }) : [];

  if (sandboxRequired && !sandboxPrefix) {
    const why = "real filesystem sandbox (bubblewrap) is required for LLM-authored verification commands but is unavailable on this system";
    logShellDecision(shellGuard, { label, command, execute: false, isolate: false, reason: "sandbox-unavailable", why });
    return { blocked: { status: 99, signal: null, stdout: "", stderr: `AUTOPILOT SHELL GUARD: blocked (sandbox-unavailable). ${why}`, shellBlocked: true, shellBlockReason: "sandbox-unavailable" } };
  }

  const decision = decideExecution({ command, networkIsolationEnabled: shellGuard.networkIsolationEnabled !== false, isolationAvailable: !!netPrefix });
  logShellDecision(shellGuard, { label, command, ...decision });

  if (!decision.execute) {
    const statusCode = decision.reason === "denylist" ? 97 : 98;
    return { blocked: { status: statusCode, signal: null, stdout: "", stderr: `AUTOPILOT SHELL GUARD: blocked (${decision.reason}). ${decision.why} Command: ${command}`, shellBlocked: true, shellBlockReason: decision.reason } };
  }

  if (decision.isolate && sandboxPrefix.length) {
    return { bin: sandboxPrefix[0], args: [...sandboxPrefix.slice(1), command] };
  }
  if (decision.isolate) {
    return { bin: netPrefix[0], args: [...netPrefix.slice(1), "sh", "-lc", command] };
  }
  if (sandboxPrefix.length) {
    return { bin: sandboxPrefix[0], args: [...sandboxPrefix.slice(1), command] };
  }
  if (process.platform === "win32") {
    return { bin: windowsComspec(), args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
  }
  return { bin: "sh", args: ["-lc", command] };
}

function runGuardedCommandBuffered(cwd, command, env, shellGuard, opts) {
  const plan = planExecution(cwd, command, shellGuard, opts);
  if (plan.blocked) return plan.blocked;
  // opts.pipe: capture stdout/stderr (strings) instead of inheriting, with an
  // optional opts.timeoutMs. Default (inherit, no timeout) is unchanged.
  const pipe = opts.pipe === true;
  return spawnSync(plan.bin, plan.args, { cwd, encoding: "utf8", stdio: pipe ? "pipe" : "inherit", env, shell: false, ...(pipe && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? { timeout: opts.timeoutMs } : {}), ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

// Capture mode: streams the command's output to the console exactly as the
// buffered mode does (the chunks are forwarded to process.stdout/stderr live)
// AND tees it to a log file, keeping the last ~80 lines for the Verifier
// brief. Returns a promise resolving to the same result shape as the buffered
// mode plus durationMs, logFile, and tail. Sandbox/guard decisions are
// unchanged (planExecution above is the single source). Options:
//   opts.logFile — destination log path (required for a useful capture);
//   a blocked command writes its guard message there too, so the log always
//   carries WHY the command never ran.
async function runGuardedCommandCaptured(cwd, command, env, shellGuard, opts) {
  const t0 = Date.now();
  const logFile = typeof opts.logFile === "string" && opts.logFile ? opts.logFile : null;
  const sink = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
  const writeLog = (chunk) => { if (sink) sink.write(chunk); };
  const finish = (result) => new Promise((resolve) => {
    if (!sink) return resolve(result);
    sink.end(() => resolve(result));
  });

  const plan = planExecution(cwd, command, shellGuard, opts);
  if (plan.blocked) {
    writeLog(plan.blocked.stderr + "\n");
    return finish({ ...plan.blocked, durationMs: Date.now() - t0, logFile, tail: plan.blocked.stderr });
  }

  // Bounded tail buffer: keep at most the last 256 KiB in memory, then slice
  // out the last ~80 lines — enough for any realistic tail and never
  // unbounded for a long suite.
  let tailBuffer = "";
  return new Promise((resolve, reject) => {
    const child = spawn(plan.bin, plan.args, { cwd, env, shell: false, stdio: ["inherit", "pipe", "pipe"], ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      writeLog(chunk);
      tailBuffer += chunk;
      if (tailBuffer.length > 262144) tailBuffer = tailBuffer.slice(-262144);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      writeLog(chunk);
      tailBuffer += chunk;
      if (tailBuffer.length > 262144) tailBuffer = tailBuffer.slice(-262144);
    });
    child.on("error", (err) => { reject(err); });
    child.on("close", (code, signal) => {
      const tail = tailBuffer.split("\n").filter((l) => l.length > 0).slice(-80).join("\n");
      finish({ status: code, signal, stdout: null, stderr: null, durationMs: Date.now() - t0, logFile, tail }).then(resolve);
    });
  });
}

// cmd.exe's own `/c` argument contract, replicated explicitly instead of via
// spawnSync's shell:true (which would hand the whole command string to a
// shell resolved from the environment rather than this fixed, trusted
// binary). `/S` changes cmd's quote-stripping rule: WITHOUT it, cmd strips
// the first and last quote it finds AND any other matching quote pair in the
// line, which mangles a command containing more than one quoted token (e.g.
// a quoted redirection target) into invalid syntax. WITH `/S`, cmd strips the
// wrapping quotes only when the entire string starts and ends with one and
// leaves everything else untouched. That means the whole command line must
// itself be wrapped in one more pair of quotes (`"${command}"`) so `/S`'s
// "starts and ends with a quote" test matches. windowsVerbatimArguments:true
// stops Node from re-escaping that already-correct argv element with its own
// MSVCRT-style quoting, which is what corrupted embedded quotes before this
// fix — this is the exact incantation Node uses internally for shell:true on
// win32 (lib/internal/child_process.js), applied here without shell:true.
function windowsComspec() {
  return process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
}
