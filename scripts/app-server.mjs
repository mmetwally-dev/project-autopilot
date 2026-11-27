// Backlog #3: the app/dev server the gate starts before the gate commands.
//
// startAppServer() picks a port, starts `tests.app_server.start_command` as
// its own process group (detached = setsid), polls ready_url until the HTTP
// status is below 500, requests every warmup_url once and returns a handle:
//   {port, baseUrl, pid, env:{APP_BASE_URL, PORT}, stop()}
// The handle is a small plain object; backlog #4 (app-net.mjs) starts the
// server INSIDE a network namespace by passing spawnPrefix (the nsenter join
// prefix) and a probe that reaches the server from inside that namespace, and
// keeps the handle alive for the verifier run.
//
// Secrets: values from env_file / env reach the server process ONLY. They are
// never written anywhere by this module; server output is kept in memory and
// every value is masked by its variable NAME (<NAME>) before any text leaves
// (failure tail, log file).
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";

export const APP_SERVER_DEFAULT_TIMEOUT_MS = 180000;
const OUTPUT_KEEP_CHARS = 200000;
const TAIL_LINES = 40;
const MIN_MASK_LEN = 4;

// Servers started by this process; reaped on SIGTERM/exit so no path leaves
// an orphan.
const liveServers = new Set();

export function appServerConfig(c) {
  const block = c?.gates?.app_server;
  if (!block || typeof block !== "object") return null;
  if (typeof block.start_command !== "string" || !block.start_command.trim()) return null;
  return block;
}

// KEY=value lines; `export ` prefix, quotes and # comments handled.
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

// Replace every secret value in `text` with <NAME>. Longest values first so a
// value containing another is masked whole.
export function maskSecrets(text, secrets) {
  let out = String(text ?? "");
  const entries = Object.entries(secrets || {})
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_MASK_LEN)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) out = out.split(value).join(`<${name}>`);
  return out;
}

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export function httpStatus(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({host: "127.0.0.1", port, path: urlPath, timeout: timeoutMs}, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

function signalGroup(pid, signal) {
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {stdio: "ignore", timeout: 5000}); } catch {}
    return;
  }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

// Safety net: a signal that reaches the process while a server is up reaps it
// first. When nothing else listens (the orchestrator installs its own flush
// handler, which also calls stopAllAppServersSync) the signal is re-raised so
// the default exit still happens.
let signalNetInstalled = false;
function installSignalNet() {
  if (signalNetInstalled) return;
  signalNetInstalled = true;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const onSignal = () => {
      stopAllAppServersSync();
      if (process.listenerCount(sig) <= 1) {
        process.removeListener(sig, onSignal);
        try { process.kill(process.pid, sig); } catch { process.exit(1); }
      }
    };
    process.on(sig, onSignal);
  }
}

// Synchronous reap for signal handlers / process exit.
export function stopAllAppServersSync() {
  for (const handle of [...liveServers]) handle._stopSync();
  for (const fn of [...extraCleanups]) { try { fn(); } catch {} }
}

// Extra synchronous cleanups (network-namespace holders, socket bridges from
// app-net.mjs) that the same signal / die() / ap stop paths must run.
const extraCleanups = new Set();
export function registerAppCleanup(fn) {
  extraCleanups.add(fn);
  return () => extraCleanups.delete(fn);
}

function tailOf(text, lines = TAIL_LINES) {
  return String(text).split(/\r?\n/).filter((l, i, a) => l !== "" || i < a.length - 1).slice(-lines).join("\n");
}

function failure(message, output, secrets) {
  const tail = tailOf(maskSecrets(output, secrets));
  return {ok: false, message, tail: tail ? `${message}\n--- last server output ---\n${tail}` : message};
}

// cfg = tests.app_server block (runtime gates.app_server), repo = repo root,
// baseEnv = the orchestrator's process env. Returns {ok:true, server} or
// {ok:false, message, tail}. Never throws.
// Backlog #4 options: spawnPrefix = argv prefix the start command runs under
// (nsenter into the phase's network namespace); probe(port, path, timeoutMs)
// -> HTTP status|null replaces the host-side request (the server is not on
// the host loopback); portFreeCheck(port) -> bool replaces the host bind test
// used before the start and after the stop.
export async function startAppServer({cfg, repo, baseEnv = process.env, log = () => {}, spawnPrefix = [], probe = null, portFreeCheck = isPortFree}) {
  const request = probe || ((port, urlPath, timeoutMs) => httpStatus(port, urlPath, timeoutMs));
  const secrets = {};
  let child = null;
  let output = "";
  try {
    const fileEnv = {};
    if (cfg.env_file) {
      const envPath = path.resolve(repo, cfg.env_file);
      let text;
      try { text = fs.readFileSync(envPath, "utf8"); }
      catch { return failure(`app_server: env_file ${cfg.env_file} cannot be read.`, "", secrets); }
      Object.assign(fileEnv, parseEnvFile(text));
    }
    const extraEnv = {};
    for (const [k, v] of Object.entries(cfg.env || {})) extraEnv[k] = String(v);
    Object.assign(secrets, fileEnv, extraEnv);

    const port = cfg.port === undefined || cfg.port === "auto" ? await pickFreePort() : Number(cfg.port);
    if (!(await portFreeCheck(port))) return failure(`app_server: port ${port} is already in use.`, "", secrets);
    const cwd = path.resolve(repo, cfg.cwd || ".");
    if (!fs.existsSync(cwd)) return failure(`app_server: cwd ${cfg.cwd} does not exist.`, "", secrets);
    const env = {...baseEnv, ...fileEnv, ...extraEnv, PORT: String(port)};
    const command = String(cfg.start_command).split("{port}").join(String(port));
    const timeoutMs = Number.isFinite(cfg.ready_timeout_ms) ? cfg.ready_timeout_ms : APP_SERVER_DEFAULT_TIMEOUT_MS;
    const readyUrl = cfg.ready_url || "/";

    const [bin, ...binArgs] = process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", command]
      : [...spawnPrefix, "sh", "-c", command];
    child = spawn(bin, binArgs,
      {cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false});
    let exited = null;
    const onData = (d) => {
      output += d.toString("utf8");
      if (output.length > OUTPUT_KEEP_CHARS) output = output.slice(-OUTPUT_KEEP_CHARS);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { exited = {error: e.message}; });
    child.on("close", (code, signal) => { exited = {code, signal}; });
    const pid = child.pid;

    let stopped = false;
    const handle = {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      pid,
      env: {APP_BASE_URL: `http://127.0.0.1:${port}`, PORT: String(port)},
      // Masked server output (last lines), safe to show.
      outputTail: () => tailOf(maskSecrets(output, secrets)),
      _stopSync() {
        if (stopped) return;
        stopped = true;
        liveServers.delete(handle);
        if (pid) { signalGroup(pid, "SIGTERM"); signalGroup(pid, "SIGKILL"); }
      },
      async stop({graceMs = 5000} = {}) {
        if (stopped) return {portFree: await portFreeCheck(port)};
        stopped = true;
        liveServers.delete(handle);
        if (pid) {
          signalGroup(pid, "SIGTERM");
          const until = Date.now() + graceMs;
          while (Date.now() < until && groupAlive(pid)) await sleep(100);
          if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
          const killUntil = Date.now() + 3000;
          while (Date.now() < killUntil && groupAlive(pid)) await sleep(50);
        }
        let portFree = false;
        const freeUntil = Date.now() + 5000;
        do { portFree = await portFreeCheck(port); if (!portFree) await sleep(100); } while (!portFree && Date.now() < freeUntil);
        if (!portFree) log(`[app-server] port ${port} still busy after stopping the server`);
        return {portFree};
      },
    };
    liveServers.add(handle);
    installSignalNet();

    log(`[app-server] starting on ${handle.baseUrl} (cwd ${cfg.cwd || "."})`);
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      if (exited) {
        await handle.stop({graceMs: 500});
        const why = exited.error ? `could not start (${exited.error})` : `exited before it was ready (${exited.signal ? `signal ${exited.signal}` : `code ${exited.code}`})`;
        return failure(`app_server: the start command ${why}.`, output, secrets);
      }
      const status = await request(port, readyUrl, Math.min(5000, Math.max(500, deadline - Date.now())));
      if (status !== null && status < 500) { ready = true; break; }
      await sleep(300);
    }
    if (!ready) {
      const last = tailOf(maskSecrets(output, secrets));
      await handle.stop({graceMs: 2000});
      return failure(`app_server: not ready after ${Math.round(timeoutMs / 1000)}s (${readyUrl} never answered with a status below 500).`, last, {});
    }
    log(`[app-server] ready (${readyUrl})`);
    for (const warm of cfg.warmup_urls || []) {
      const t0 = Date.now();
      const status = await request(port, warm, Math.max(5000, Math.min(180000, timeoutMs)));
      log(`[app-server] warm-up ${warm} -> ${status ?? "no answer"} (${Date.now() - t0} ms)`);
    }
    return {ok: true, server: handle};
  } catch (error) {
    if (child?.pid) { signalGroup(child.pid, "SIGTERM"); signalGroup(child.pid, "SIGKILL"); }
    return failure(`app_server: ${maskSecrets(error?.message || String(error), secrets)}`, output, secrets);
  }
}
