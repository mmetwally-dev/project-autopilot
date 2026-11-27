// Backlog #4: one isolated network namespace per phase check, shared by the
// app server, the gate commands and the verifier's browser command.
//
// startAppSession() creates the namespace with a small HOLDER process
// (`unshare -Urn` + loopback up + a loop that exits when the orchestrator
// dies), starts the app server INSIDE it and returns a session. Anyone who
// must reach the server joins the same namespace through session.joinPrefix
// (`nsenter -U --preserve-credentials -n -t <holder> --`): gate commands (via
// shellGuard.netnsJoinPrefix in guarded-command.mjs) and the verifier's
// approved browser command (buildNetworkIsolationInvocation's
// joinNetworkNamespace option). The namespace has loopback and nothing else:
// no route to the host loopback, the LAN or the internet.
//
// Which processes get which network:
//   mode "namespace" (default)  server, holder, gate commands, verifier
//                               browser command: the namespace (loopback only).
//   mode "host-bridge" (allow_hosts set): the SERVER runs on the host network
//                               (so it can reach the allowlisted host, e.g. the
//                               Supabase domain); gate commands and the browser
//                               stay in the closed namespace and reach the
//                               server only through a socket bridge:
//                               ns 127.0.0.1:<port> -> unix socket (a file, not
//                               scoped to a network namespace) -> host
//                               127.0.0.1:<port>. In addition (backlog #7), an
//                               allowlisting HTTP CONNECT proxy process runs on
//                               the host (only allow_hosts on port 443; any
//                               other host/port is refused with 403 and logged)
//                               and is reached from inside the namespace via a
//                               second unix-socket bridge (`127.0.0.1:<proxyPort>`),
//                               so Chromium launched by `ap-browser-check` can
//                               reach the allowlisted domains directly from the
//                               browser while staying closed to everything else.
//   mode "host" (gates.network_isolation=false): as in backlog #3, everything on
//                               the host network.
// The verifier AGENT process itself keeps the host network (its provider calls
// need it); it never talks to the server directly, only the namespace-joined
// commands do.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {networkIsolationPrefix} from "./shell-guard.mjs";
import {startAppServer, isPortFree, pickFreePort, registerAppCleanup} from "./app-server.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function appServerAllowHosts(cfg) {
  return Array.isArray(cfg?.allow_hosts) ? cfg.allow_hosts.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim()) : [];
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}
function pidAliveAndNotZombie(pid) {
  if (!pid || !groupAlive(pid)) return false;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      if (state === "Z" || state === "X") return false;
      fs.accessSync(`/proc/${pid}/ns/net`);
    } catch {
      return false;
    }
  }
  return true;
}
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

// Argv prefix that joins the holder's namespaces. `unshare -Urn` creates a
// user + net namespace (unprivileged, e.g. WSL2); `unshare --net` only a net one.
export function nsenterJoinPrefix(holderPid, flag) {
  return ["nsenter", ...(flag === "-Urn" ? ["-U", "--preserve-credentials"] : []), "-n", "-t", String(holderPid), "--"];
}

// Starts the namespace holder. Resolves {pid, flag, joinPrefix, kill(), alive()}
// or {error}. The holder brings loopback up, prints "ready" and then blocks on
// its inherited stdin pipe until the orchestrator closes it or dies (even on
// SIGKILL, because Node opens child pipes with O_CLOEXEC so sibling children do
// not hold the write end open). This avoids cross-user-namespace `kill -0`
// permission issues, periodic `sleep` fork churn, and PID-reuse races.
export async function startNamespaceHolder({timeoutMs = 10000} = {}) {
  const prefix = networkIsolationPrefix();
  if (!prefix) return {error: "network isolation (unshare) is not available on this system"};
  const flag = prefix[1];
  const script = 'ip link set lo up 2>/dev/null || exit 3; echo ready; while IFS= read -r _; do :; done';
  const child = spawn(prefix[0], [flag, "--", "sh", "-c", script, "autopilot-netns-holder"], {detached: true, stdio: ["pipe", "pipe", "pipe"]});
  child.stdin.on("error", () => {});
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("close", () => { exited = true; });
  let err = "";
  child.stderr.on("data", (d) => { err += d.toString("utf8"); });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    child.stdout.once("data", () => { clearTimeout(timer); resolve("ready"); });
    child.once("error", (e) => { clearTimeout(timer); err += e.message; resolve("error"); });
    child.once("close", () => { clearTimeout(timer); resolve("closed"); });
  });
  if (outcome !== "ready") {
    try { child.stdin.destroy(); } catch {}
    if (child.pid) killGroup(child.pid, "SIGKILL");
    return {error: `could not create the network namespace (${outcome}${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""})`};
  }
  child.stdout.resume();
  child.stderr.resume();
  try { child.stdin._handle?.unref?.(); } catch {}
  try { child.stdout._handle?.unref?.(); } catch {}
  try { child.stderr._handle?.unref?.(); } catch {}
  child.unref();
  return {
    pid: child.pid,
    flag,
    joinPrefix: nsenterJoinPrefix(child.pid, flag),
    kill() {
      try { child.stdin.destroy(); } catch {}
      killGroup(child.pid, "SIGKILL");
    },
    alive: () => !exited && pidAliveAndNotZombie(child.pid),
  };
}

// Runs a node one-liner inside the namespace and resolves its trimmed stdout.
function runInNamespace(joinPrefix, nodeArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(joinPrefix[0], [...joinPrefix.slice(1), process.execPath, ...nodeArgs], {stdio: ["ignore", "pipe", "ignore"]});
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

const STATUS_SCRIPT = 'const h=require("http");const q=h.get({host:"127.0.0.1",port:+process.argv[1],path:process.argv[2],timeout:+process.argv[3]},r=>{r.resume();r.on("end",()=>console.log(r.statusCode));r.on("error",()=>console.log("null"))});q.on("timeout",()=>q.destroy());q.on("error",()=>console.log("null"))';

export function namespaceProbe(joinPrefix) {
  return async (port, urlPath, timeoutMs) => {
    const out = await runInNamespace(joinPrefix, ["-e", STATUS_SCRIPT, String(port), urlPath, String(timeoutMs)], timeoutMs + 5000);
    const n = Number(out);
    return out && Number.isFinite(n) ? n : null;
  };
}

// Listens on 127.0.0.1:<port> INSIDE the namespace and pipes every connection
// to a unix socket (argv[2]).
const NS_FORWARDER_SCRIPT = 'const net=require("net");const sock=process.argv[2];net.createServer(c=>{const u=net.connect(sock);c.pipe(u);u.pipe(c);const end=()=>{c.destroy();u.destroy()};c.on("error",end);u.on("error",end);c.on("close",end);u.on("close",end)}).listen(+process.argv[1],"127.0.0.1",()=>console.log("ready"))';

// Host side of the bridge: its own process (an in-process relay would stall
// whenever the orchestrator blocks in a synchronous call): unix socket ->
// host 127.0.0.1:<port>. Prints "ready" once listening.
const HOST_FORWARDER_SCRIPT = 'const net=require("net");const [sock,port]=process.argv.slice(1);net.createServer(c=>{const t=net.connect(+port,"127.0.0.1");c.pipe(t);t.pipe(c);const end=()=>{c.destroy();t.destroy()};c.on("error",end);t.on("error",end);c.on("close",end);t.on("close",end)}).listen(sock,()=>console.log("ready"))';

function startNsForwarder(joinPrefix, port, sockPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(joinPrefix[0], [...joinPrefix.slice(1), process.execPath, "-e", NS_FORWARDER_SCRIPT, String(port), sockPath], {detached: true, stdio: ["ignore", "pipe", "ignore"]});
    const timer = setTimeout(() => { killGroup(child.pid, "SIGKILL"); reject(new Error(`namespace forwarder for port ${port} did not start`)); }, 10000);
    child.stdout.once("data", () => { clearTimeout(timer); child.stdout.resume(); child.unref(); resolve(child); });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(`namespace forwarder for port ${port} exited`)); });
  });
}

function startHostSide(sockPath, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", HOST_FORWARDER_SCRIPT, sockPath, String(port)], {detached: true, stdio: ["ignore", "pipe", "ignore"]});
    const timer = setTimeout(() => { killGroup(child.pid, "SIGKILL"); reject(new Error("host-side forwarder did not start")); }, 10000);
    child.stdout.once("data", () => { clearTimeout(timer); child.stdout.resume(); child.unref(); resolve(child); });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("host-side forwarder exited")); });
  });
}

// Backlog #7: allowlisting HTTP CONNECT proxy process on the host (only
// allow_hosts on port 443; any other host, port or HTTP method is refused with
// 403 and logged). Runs as its own detached process on the host (like
// startHostSide, so it never stalls when the orchestrator runs a synchronous
// call). Listens on a unix socket (`sockPath`) when reached from inside the
// namespace through `NS_FORWARDER_SCRIPT`, or on `127.0.0.1:<listenPort>` when
// used directly on the host. Supports an optional `resolveOverrides` map
// (`{"demo.supabase.co": {host: "127.0.0.1", port: 12345}}`) so tests can map
// an allowed hostname to a local TCP/TLS fixture target without DNS.
const HOST_CONNECT_PROXY_SCRIPT = `
const net = require("net");
const listenTarget = process.argv[1];
const allowJson = process.env.AUTOPILOT_ALLOW_HOSTS_JSON || process.argv[2] || "[]";
const overridesJson = process.env.AUTOPILOT_PROXY_OVERRIDES_JSON || process.argv[3] || "{}";
const allowSet = new Set((JSON.parse(allowJson) || []).map((h) => String(h).trim().toLowerCase().replace(/\\.$/, "")).filter(Boolean));
const rawOverrides = JSON.parse(overridesJson) || {};
const overrides = {};
for (const [k, v] of Object.entries(rawOverrides)) {
  overrides[String(k).trim().toLowerCase().replace(/\\.$/, "")] = v;
}
function parseConnectTarget(rawTarget) {
  const t = String(rawTarget || "").trim();
  const m = /^([A-Za-z0-9._-]+|\\[[0-9a-fA-F:]+\\]):(\\d+)$/.exec(t);
  if (!m) return null;
  return {host: m[1].toLowerCase().replace(/\\.$/, ""), port: Number(m[2])};
}
const srv = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf("\\r\\n\\r\\n");
    if (idx === -1) {
      if (buf.length > 16384) {
        client.removeListener("data", onData);
        console.error("[allow-proxy] REFUSED 400 header_too_large");
        try { client.end("HTTP/1.1 400 Bad Request\\r\\nConnection: close\\r\\n\\r\\n"); } catch {}
      }
      return;
    }
    client.removeListener("data", onData);
    const head = buf.subarray(0, idx).toString("latin1");
    const rest = buf.subarray(idx + 4);
    const firstLine = (head.split("\\r\\n")[0] || "").trim();
    const parts = firstLine.split(/\\s+/);
    const method = (parts[0] || "").toUpperCase();
    const rawTarget = parts[1] || "";
    if (method !== "CONNECT") {
      console.error("[allow-proxy] REFUSED 403 method=" + method + " target=" + rawTarget + " (only CONNECT allowed)");
      try { client.end("HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nForbidden by Autopilot allow_hosts proxy (only CONNECT allowed)\\n"); } catch {}
      return;
    }
    const parsed = parseConnectTarget(rawTarget);
    if (!parsed || parsed.port !== 443 || !allowSet.has(parsed.host)) {
      const reason = !parsed ? "invalid_target" : (parsed.port !== 443 ? "port_not_443" : "host_not_allowed");
      console.error("[allow-proxy] REFUSED 403 target=" + rawTarget + " (" + reason + ")");
      try { client.end("HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nForbidden by Autopilot allow_hosts proxy (" + reason + ")\\n"); } catch {}
      return;
    }
    const ov = overrides[parsed.host];
    let dstHost = parsed.host;
    let dstPort = 443;
    if (ov !== undefined && ov !== null) {
      if (typeof ov === "number") { dstHost = "127.0.0.1"; dstPort = Number(ov); }
      else if (typeof ov === "string") {
        const idxColon = ov.lastIndexOf(":");
        if (idxColon > 0) { dstHost = ov.slice(0, idxColon); dstPort = Number(ov.slice(idxColon + 1)) || 443; }
        else { dstHost = ov; }
      } else if (typeof ov === "object") {
        if (ov.host) dstHost = String(ov.host);
        if (ov.port) dstPort = Number(ov.port);
      }
    }
    console.error("[allow-proxy] ALLOWED CONNECT " + parsed.host + ":443");
    const upstream = net.connect({host: dstHost, port: dstPort}, () => {
      try {
        client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      } catch {
        client.destroy();
        upstream.destroy();
      }
    });
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on("error", end);
    upstream.on("error", (e) => {
      if (!upstream.connecting) { end(); return; }
      try { client.end("HTTP/1.1 502 Bad Gateway\\r\\nConnection: close\\r\\n\\r\\n"); } catch {}
      end();
    });
    client.on("close", end);
    upstream.on("close", end);
  };
  client.on("data", onData);
  client.on("error", () => client.destroy());
});
const onListening = () => {
  const addr = srv.address();
  const port = addr && typeof addr === "object" ? addr.port : null;
  console.log("ready" + (port ? ":" + port : ""));
};
if (/^\\d+$/.test(listenTarget)) srv.listen(Number(listenTarget), "127.0.0.1", onListening);
else srv.listen(listenTarget, onListening);
`;

export function startAllowlistProxy({sockPath = null, listenPort = 0, allowHosts = [], resolveOverrides = null, log = () => {}} = {}) {
  return new Promise((resolve, reject) => {
    const target = sockPath ? String(sockPath) : String(listenPort || 0);
    const allowJson = JSON.stringify(allowHosts || []);
    const overridesJson = JSON.stringify(resolveOverrides || {});
    const child = spawn(
      process.execPath,
      ["-e", HOST_CONNECT_PROXY_SCRIPT, target, allowJson, overridesJson],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AUTOPILOT_ALLOW_HOSTS_JSON: allowJson,
          AUTOPILOT_PROXY_OVERRIDES_JSON: overridesJson,
        },
      }
    );
    const logs = [];
    let stderrBuf = "";
    child.stderr.on("data", (d) => {
      stderrBuf += d.toString("utf8");
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        logs.push(line.trim());
        log(line.trim());
      }
    });
    const timer = setTimeout(() => { killGroup(child.pid, "SIGKILL"); reject(new Error("host allowlist proxy did not start")); }, 10000);
    child.stdout.once("data", (d) => {
      clearTimeout(timer);
      const text = d.toString("utf8").trim();
      const m = /^ready(?::(\d+))?/.exec(text);
      const port = m && m[1] ? Number(m[1]) : (listenPort || null);
      child.stdout.resume();
      child.unref();
      resolve({
        pid: child.pid,
        port,
        sockPath,
        logs: () => [...logs],
        stop() { killGroup(child.pid, "SIGKILL"); },
        alive: () => groupAlive(child.pid),
      });
    });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("host allowlist proxy exited")); });
  });
}

// Private directory for the bridge's unix socket. A socket path is limited to
// about 100 bytes, so a long TMPDIR falls back to a shorter private location.
export function makeSocketDir(prefix = "ap-appnet-") {
  const bases = [os.tmpdir(), process.env.XDG_RUNTIME_DIR, "/dev/shm", "/tmp"].filter(Boolean);
  for (const base of bases) {
    if (path.join(base, `${prefix}XXXXXX`, "app.sock").length > 100) continue;
    try { return fs.mkdtempSync(path.join(base, prefix)); } catch {}
  }
  throw new Error("no private directory short enough for a unix socket");
}

// cfg = tests.app_server block, repo = repo root. Resolves {ok:true, session}
// or {ok:false, message, tail}. Never throws.
// proxyResolveOverrides is an optional test-only map (`{hostname: {host, port}}`)
// forwarded to the host allowlist CONNECT proxy so offline tests can map an
// allowlisted domain name to a local fixture target.
export async function startAppSession({cfg, repo, baseEnv = process.env, log = () => {}, networkIsolation = true, proxyResolveOverrides = null}) {
  const allowHosts = appServerAllowHosts(cfg);
  let holder = null;
  let hostBridge = null;
  let bridgeProc = null;
  let hostProxy = null;
  let proxyBridgeProc = null;
  let proxyPort = null;
  let sockDir = null;
  let stopped = false;
  let unregister = () => {};

  const cleanupSync = () => {
    if (proxyBridgeProc?.pid) killGroup(proxyBridgeProc.pid, "SIGKILL");
    if (hostProxy?.pid) killGroup(hostProxy.pid, "SIGKILL");
    if (bridgeProc?.pid) killGroup(bridgeProc.pid, "SIGKILL");
    if (hostBridge?.pid) killGroup(hostBridge.pid, "SIGKILL");
    if (holder) holder.kill();
    if (sockDir) { try { fs.rmSync(sockDir, {recursive: true, force: true}); } catch {} }
  };

  let mode = "host";
  if (networkIsolation !== false) mode = allowHosts.length ? "host-bridge" : "namespace";

  try {
    if (mode !== "host") {
      const h = await startNamespaceHolder();
      if (h.error) {
        return {ok: false, message: `app_server: ${h.error}. Set tests.gate_network to false to run the server on the host network instead.`, tail: `app_server: ${h.error}.`};
      }
      holder = h;
      unregister = registerAppCleanup(cleanupSync);
    }
    const joinPrefix = holder ? holder.joinPrefix : null;
    const probe = joinPrefix ? namespaceProbe(joinPrefix) : null;

    const started = mode === "namespace"
      ? await startAppServer({cfg, repo, baseEnv, log, spawnPrefix: joinPrefix, probe, portFreeCheck: async () => true})
      : await startAppServer({cfg, repo, baseEnv, log});
    if (!started.ok) {
      unregister(); cleanupSync();
      return started;
    }
    const server = started.server;
    const port = server.port;

    const fail = async (message) => {
      await server.stop({graceMs: 1000});
      unregister(); cleanupSync();
      return {ok: false, message, tail: message};
    };

    if (mode === "host-bridge") {
      try {
        sockDir = makeSocketDir();
        fs.chmodSync(sockDir, 0o700);
        const sockPath = path.join(sockDir, "app.sock");
        hostBridge = await startHostSide(sockPath, port);
        bridgeProc = await startNsForwarder(joinPrefix, port, sockPath);

        // Backlog #7: start the allowlisting HTTP CONNECT proxy on the host and
        // expose it inside the namespace at 127.0.0.1:<proxyPort> via a second
        // unix socket in the same private sockDir.
        const proxySockPath = path.join(sockDir, "proxy.sock");
        let pickedProxyPort = await pickFreePort();
        while (pickedProxyPort === port) pickedProxyPort = await pickFreePort();
        proxyPort = pickedProxyPort;
        hostProxy = await startAllowlistProxy({
          sockPath: proxySockPath,
          allowHosts,
          resolveOverrides: proxyResolveOverrides || cfg?._proxyResolveOverrides || null,
          log,
        });
        proxyBridgeProc = await startNsForwarder(joinPrefix, proxyPort, proxySockPath);
      } catch (error) {
        return fail(`app_server: could not set up the namespace bridge (${error?.message || error}).`);
      }
      const readyUrl = cfg.ready_url || "/";
      let status = null;
      const until = Date.now() + 10000;
      while (Date.now() < until && !(status !== null && status < 500)) {
        status = await probe(port, readyUrl, 3000);
        if (status === null) await sleep(200);
      }
      if (status === null || status >= 500) return fail("app_server: the namespace bridge to the host server did not answer.");
      log(`[app-server] host-bridge ready: the server uses the host network (allow_hosts: ${allowHosts.join(", ")}); gate commands and the browser reach it only through the closed namespace (browser CONNECT proxy on 127.0.0.1:${proxyPort})`);
    } else if (mode === "namespace") {
      log(`[app-server] network namespace ready (holder pid ${holder.pid}): server, gate commands and the verifier's browser command share loopback only`);
    }

    const proxyUrl = proxyPort ? `http://127.0.0.1:${proxyPort}` : null;
    const session = {
      mode,
      port,
      baseUrl: server.baseUrl,
      proxyPort,
      proxyUrl,
      proxyLogs: () => (hostProxy ? hostProxy.logs() : []),
      env: server.env,
      server,
      holderPid: holder ? holder.pid : null,
      bridgePids: [hostBridge?.pid, bridgeProc?.pid, hostProxy?.pid, proxyBridgeProc?.pid].filter(Boolean),
      joinPrefix,
      allowHosts,
      // Spawns argv inside the session's namespace (host network in mode "host").
      spawnArgs(argv) { return joinPrefix ? [joinPrefix[0], [...joinPrefix.slice(1), ...argv.map(String)]] : [String(argv[0]), argv.slice(1).map(String)]; },
      outputTail: () => server.outputTail(),
      alive: () => !stopped && (!holder || holder.alive()),
      async stop(opts) {
        if (stopped) return {portFree: true};
        stopped = true;
        let portFree = true;
        const r = await server.stop(opts);
        if (mode === "namespace") portFree = true;
        else portFree = r.portFree;
        cleanupSync();
        unregister();
        const pidsToReap = [holder?.pid, hostBridge?.pid, bridgeProc?.pid, hostProxy?.pid, proxyBridgeProc?.pid].filter(Boolean);
        if (pidsToReap.length) {
          const until = Date.now() + 3000;
          while (Date.now() < until && pidsToReap.some((p) => groupAlive(p))) await sleep(50);
          if (holder && groupAlive(holder.pid)) portFree = false;
        }
        if (mode === "host-bridge" && !(await isPortFree(port))) portFree = false;
        return {portFree};
      },
    };
    return {ok: true, session};
  } catch (error) {
    unregister(); cleanupSync();
    return {ok: false, message: `app_server: ${error?.message || error}`, tail: `app_server: ${error?.message || error}`};
  }
}

// Verifier brief text, empty when no server is up.
export function verifierAppNote(session) {
  if (!session || session.alive?.() === false) return "";
  const where = session.mode === "host"
    ? "on the host network"
    : "inside an isolated network namespace (loopback only; the outside network is closed)";
  const reach = session.mode === "host"
    ? "Reach it with your normal tools."
    : "It is NOT on the host loopback: only commands run through the orchestrator's namespace-joined approved command reach it. Do not start another server.";
  return `APP_BASE_URL=${session.baseUrl}\nThe app server is already running at ${session.baseUrl} (${where}), warmed up by the gate. ${reach}`;
}

