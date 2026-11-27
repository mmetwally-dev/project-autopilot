#!/usr/bin/env node
// Backlog #4: one isolated network namespace per phase check. Real unshare,
// nsenter and bubblewrap; the #3 fixture server; a decoy listener on the HOST
// loopback that nothing inside the namespace may reach.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {startAppSession, verifierAppNote, appServerAllowHosts, startAllowlistProxy} from "./app-net.mjs";
import {isPortFree} from "./app-server.mjs";
import {validateAppServerConfig} from "./config-validation.mjs";
import {buildExecutionEnvelope, mapEnvironmentIntoEnvelope, buildNetworkIsolationInvocation} from "./execution-envelope.mjs";
import {networkIsolationPrefix} from "./shell-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "test-fixtures", "fake-app-server.mjs");
const DRIVER = path.join(here, "test-fixtures", "app-net-driver.mjs");

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tmpDirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

if (!networkIsolationPrefix() || spawnSync("sh", ["-c", "command -v nsenter"]).status !== 0) {
  console.log("skip: unshare/nsenter network namespaces are not available here");
  process.exit(0);
}

// A listener on the host loopback: inside the namespace it must stay unreachable.
let decoyHits = 0;
const decoy = net.createServer((c) => { decoyHits++; c.end("decoy"); });
await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
const decoyPort = decoy.address().port;

function appCfg(extra = {}, env = {}) {
  return {
    start_command: `node ${JSON.stringify(FIXTURE)}`,
    port: "auto", ready_url: "/ready", warmup_urls: ["/warm"], ready_timeout_ms: 20000,
    env: {FIXTURE_DELAY_MS: "300", ...env},
    ...extra,
  };
}
const repo = tmp("autopilot-appnet-repo-");
spawnSync("git", ["init", "-q", repo]);

const PROBE = `
const net=require("net"),http=require("http"),fs=require("fs");
const [base,decoy]=process.argv.slice(1);
const res={ns:fs.readlinkSync("/proc/self/ns/net")};
const tcp=(h,p)=>new Promise(r=>{const c=net.connect({host:h,port:p,timeout:2500});c.on("connect",()=>{c.destroy();r("connected")});c.on("timeout",()=>{c.destroy();r("timeout")});c.on("error",e=>r(e.code))});
(async()=>{
  res.server=await new Promise(r=>http.get(base+"/hello",x=>{x.resume();r(x.statusCode)}).on("error",e=>r(e.code)));
  res.decoy=await tcp("127.0.0.1",+decoy);
  res.outside=await tcp("1.1.1.1",80);
  console.log(JSON.stringify(res));
})();`;
function probe(session, wrap = (bin, args) => [bin, args]) {
  const [b0, a0] = session.spawnArgs([process.execPath, "-e", PROBE, session.baseUrl, String(decoyPort)]);
  const [bin, args] = wrap(b0, a0);
  const r = spawnSync(bin, args, {encoding: "utf8", timeout: 30000});
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return {error: (r.stderr || r.stdout).slice(-300)}; }
}
function holdersOfThisProcess() {
  const out = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid !== process.pid) continue;
      if (fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes("ip link set lo up")) out.push(Number(d));
    } catch {}
  }
  return out;
}
const hostNs = fs.readlinkSync("/proc/self/ns/net");

// --- 1. namespace mode: server inside, joined commands reach it only -------
console.log("namespace session");
let holderPid, serverPid, port, nsLink;
{
  const reqLog = path.join(tmp("autopilot-appnet-w-"), "req.log");
  const stateFile = reqLog + ".state";
  const r = await startAppSession({cfg: appCfg({}, {FIXTURE_REQUEST_LOG: reqLog, FIXTURE_STATE_FILE: stateFile}), repo, networkIsolation: true});
  check("session starts", r.ok === true, r);
  const s = r.session;
  holderPid = s.holderPid; port = s.port;
  serverPid = JSON.parse(fs.readFileSync(stateFile, "utf8")).pid;
  check("mode is namespace", s.mode === "namespace");
  nsLink = fs.readlinkSync(`/proc/${holderPid}/ns/net`);
  check("holder lives in another network namespace than the host", nsLink !== hostNs);
  check("server lives in the holder's namespace", fs.readlinkSync(`/proc/${serverPid}/ns/net`) === nsLink);
  const reqs = fs.readFileSync(reqLog, "utf8").split("\n").filter(Boolean);
  check("readiness poll and warm-up reached the server inside", reqs.includes("/ready") && reqs.includes("/warm"), reqs);
  check("server is NOT reachable on the host loopback", !(await new Promise((res) => { const c = net.connect(port, "127.0.0.1"); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false)); })));
  const p = probe(s);
  check("a joined command reaches 127.0.0.1:<port>", p.server === 200, p);
  check("the joined command is in the holder's namespace", p.ns === nsLink, p);
  check("the host-loopback decoy is unreachable from inside", p.decoy === "ECONNREFUSED" && decoyHits === 0, {p, decoyHits});
  check("the outside network is unreachable from inside", ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(p.outside), p);

  // The verifier's browser command: a read-only bwrap envelope joined to the same namespace.
  {
    const inner = buildExecutionEnvelope({repo, scratchDir: tmp("autopilot-appnet-scratch-"), readOnly: true, config: {}, binary: process.execPath, args: ["-e", PROBE, s.baseUrl, String(decoyPort)]});
    if (!inner.available) {
      check("verifier-style envelope builds", false, inner.reason);
    } else {
      const inv = buildNetworkIsolationInvocation({binary: inner.binary, args: inner.args, cwd: inner.cwd, joinNetworkNamespace: s.joinPrefix});
      const mapped = mapEnvironmentIntoEnvelope({PATH: process.env.PATH, LANG: "C.UTF-8"}, inner, repo, inner.cwd);
      const vr = spawnSync(inv.binary, inv.args, {cwd: inner.cwd, env: mapped, encoding: "utf8", timeout: 30000});
      let vp = null;
      try { vp = JSON.parse(vr.stdout.trim().split("\n").pop()); } catch {}
      check("verifier-style read-only envelope joined to the namespace reaches the server", vp?.server === 200, {status: vr.status, out: vr.stdout.slice(-200), err: vr.stderr.slice(-300)});
      check("the verifier command shares the very same namespace", vp?.ns === nsLink, vp);
      check("verifier command: decoy and outside network unreachable", vp?.decoy === "ECONNREFUSED" && ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(vp?.outside) && decoyHits === 0, vp);
    }
  }

  const stopped = await s.stop();
  check("stop reports the port free", stopped.portFree === true, stopped);
  check("server process is gone", !alive(serverPid));
  check("holder is gone", !alive(holderPid));
  check("no holder left under this process", holdersOfThisProcess().length === 0, holdersOfThisProcess());
}

// --- 2. start failure leaves nothing behind --------------------------------
console.log("start failure cleanup");
{
  const r = await startAppSession({cfg: appCfg({}, {FIXTURE_MODE: "exit"}), repo, networkIsolation: true});
  check("start failure is reported", r.ok === false && /exited before it was ready/.test(r.message), r);
  check("holder is gone after a failed start", holdersOfThisProcess().length === 0, holdersOfThisProcess());
  const t = await startAppSession({cfg: appCfg({ready_timeout_ms: 1500}, {FIXTURE_MODE: "never-ready"}), repo, networkIsolation: true});
  check("ready timeout is reported", t.ok === false && /not ready after/.test(t.message), t);
  check("holder is gone after a timeout", holdersOfThisProcess().length === 0, holdersOfThisProcess());
}

// --- 3. allow_hosts: host-bridge fallback ----------------------------------
console.log("allow_hosts host-bridge");
{
  const stateFile = path.join(tmp("autopilot-appnet-bw-"), "state.json");
  check("allow_hosts is read from the block", appServerAllowHosts({allow_hosts: [" a.supabase.co ", "", 3]}).join() === "a.supabase.co");
  const r = await startAppSession({cfg: appCfg({allow_hosts: ["demo.supabase.co"]}, {FIXTURE_STATE_FILE: stateFile}), repo, networkIsolation: true});
  check("session starts with allow_hosts", r.ok === true, r);
  const s = r.session;
  const sp = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check("mode is host-bridge", s.mode === "host-bridge");
  check("the server itself runs on the HOST network", fs.readlinkSync(`/proc/${sp.pid}/ns/net`) === hostNs);
  check("the server answers on the host loopback", await new Promise((res) => { const c = net.connect(s.port, "127.0.0.1"); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false)); }));
  const p = probe(s);
  check("a namespace command reaches the server through the bridge", p.server === 200, p);
  check("the namespace command is in the closed namespace", p.ns !== hostNs && p.ns === fs.readlinkSync(`/proc/${s.holderPid}/ns/net`), p);
  check("host decoy still unreachable from the namespace", p.decoy === "ECONNREFUSED" && decoyHits === 0, {p, decoyHits});
  check("outside network still unreachable from the namespace", ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(p.outside), p);
  const holder = s.holderPid;
  check("four bridge processes run (server bridge + allowlist proxy bridge)", s.bridgePids.length === 4 && s.bridgePids.every(alive), s.bridgePids);
  const stopped = await s.stop();
  check("stop frees the port", stopped.portFree === true && await isPortFree(s.port), stopped);
  check("server, holder and all bridge/proxy processes are gone", !alive(sp.pid) && !alive(holder) && holdersOfThisProcess().length === 0 && s.bridgePids.every((b) => !alive(b)), s.bridgePids);
  check("the socket directory is removed", !["/dev/shm", "/tmp", os.tmpdir()].some((b) => { try { return fs.readdirSync(b).some((n) => n.startsWith("ap-appnet-") && fs.existsSync(path.join(b, n, "app.sock"))); } catch { return false; } }));
}

// --- 3b. allow_hosts CONNECT proxy in the namespace -------------------------
function startFixtureTarget({expectMatch = null, reply = "PONG", hitsFile}) {
  fs.writeFileSync(hitsFile, "0");
  const script = `
const fs = require("fs");
const net = require("net");
const [hitsFile, expectMatch, reply] = process.argv.slice(1);
let hits = 0;
const srv = net.createServer((c) => {
  hits += 1;
  try { fs.writeFileSync(hitsFile, String(hits)); } catch {}
  if (!expectMatch) {
    c.end(reply);
    return;
  }
  let buf = "";
  c.on("data", (d) => {
    buf += d.toString("utf8");
    if (buf.includes(expectMatch)) c.end(reply);
  });
  c.on("error", () => {});
});
srv.listen(0, "127.0.0.1", () => {
  console.log("ready:" + srv.address().port);
});
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, hitsFile, expectMatch || "", reply], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("fixture target timeout"));
    }, 10000);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
      const m = /ready:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({
          port: Number(m[1]),
          hits: () => Number(fs.readFileSync(hitsFile, "utf8").trim() || "0"),
          close: () => { try { child.kill("SIGKILL"); } catch {} },
        });
      }
    });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

console.log("allow_hosts CONNECT proxy in namespace");
{
  // Start two local TCP fixture targets on the host as separate child processes
  // (so synchronous in-namespace spawns never block their event loop): one
  // mapped to an allowed domain ("allowed.supabase.co"), one mapped to a
  // non-allowed domain ("forbidden.example.com").
  const fixDir = tmp("autopilot-appnet-fix-");
  const allowedTarget = await startFixtureTarget({
    expectMatch: "PING",
    reply: "PONG_ALLOWED_443",
    hitsFile: path.join(fixDir, "allowed.hits"),
  });
  const forbiddenTarget = await startFixtureTarget({
    expectMatch: null,
    reply: "PONG_FORBIDDEN",
    hitsFile: path.join(fixDir, "forbidden.hits"),
  });

  const r = await startAppSession({
    cfg: appCfg({allow_hosts: ["allowed.supabase.co"]}),
    repo,
    networkIsolation: true,
    proxyResolveOverrides: {
      "allowed.supabase.co": {host: "127.0.0.1", port: allowedTarget.port},
      "forbidden.example.com": {host: "127.0.0.1", port: forbiddenTarget.port},
    },
  });
  check("session with allow_hosts proxy starts", r.ok === true && Number.isInteger(r.session.proxyPort), r);
  const s = r.session;

  const CONNECT_PROBE = `
const net = require("net");
const [proxyPort, target] = process.argv.slice(1);
let settled = false;
let buf = "";
let tunneled = false;
const finish = (obj, sock) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.log(JSON.stringify(obj));
  try { sock.destroy(); } catch {}
};
const c = net.connect({host: "127.0.0.1", port: Number(proxyPort)}, () => {
  c.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n");
});
const timer = setTimeout(() => finish({error: "timeout", buf}, c), 5000);
c.on("data", (d) => {
  buf += d.toString("utf8");
  if (!tunneled && buf.includes("\\r\\n\\r\\n")) {
    const [head, rest] = buf.split("\\r\\n\\r\\n");
    const status = Number((head.split("\\r\\n")[0] || "").split(/\\s+/)[1] || 0);
    if (status === 200) {
      tunneled = true;
      buf = rest || "";
      c.write("PING\\n");
    } else {
      finish({status, head: head.split("\\r\\n")[0]}, c);
    }
  } else if (tunneled && buf.includes("PONG_")) {
    finish({status: 200, body: buf.trim()}, c);
  }
});
c.on("error", (e) => finish({error: e.code || e.message}, c));
c.on("close", () => finish({error: "closed_early", buf}, c));
`;
  const runConnectInNs = (target) => new Promise((resolve) => {
    const [bin, args] = s.spawnArgs([process.execPath, "-e", CONNECT_PROBE, String(s.proxyPort), target]);
    const child = spawn(bin, args, {stdio: ["ignore", "pipe", "pipe"]});
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 15000);
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split("\n").pop())); }
      catch { resolve({error: (err || out).slice(-300)}); }
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({error: e.message}); });
  });

  const okRes = await runConnectInNs("allowed.supabase.co:443");
  const allowedHitsAfterOk = allowedTarget.hits();
  check("in-namespace CONNECT to allowed host:443 succeeds and reaches host fixture",
    okRes.status === 200 && okRes.body === "PONG_ALLOWED_443" && allowedHitsAfterOk === 1,
    {okRes, allowedTargetHits: allowedHitsAfterOk});

  const badHostRes = await runConnectInNs("forbidden.example.com:443");
  const forbiddenHitsAfterBad = forbiddenTarget.hits();
  check("in-namespace CONNECT to non-allowed host is refused with 403 and never hits target",
    badHostRes.status === 403 && forbiddenHitsAfterBad === 0,
    {badHostRes, forbiddenTargetHits: forbiddenHitsAfterBad});

  const hitsBeforeBadPort = allowedTarget.hits();
  const badPortRes = await runConnectInNs("allowed.supabase.co:8443");
  const hitsAfterBadPort = allowedTarget.hits();
  check("in-namespace CONNECT to allowed host on non-443 port is refused with 403",
    badPortRes.status === 403 && hitsAfterBadPort === hitsBeforeBadPort,
    {badPortRes, allowedTargetHits: hitsAfterBadPort, hitsBeforeBadPort});

  await sleep(150);
  const proxyLogs = s.proxyLogs();
  check("proxy logged the allowed CONNECT and both 403 refusals",
    proxyLogs.some((l) => l.includes("ALLOWED CONNECT allowed.supabase.co:443"))
    && proxyLogs.some((l) => l.includes("REFUSED 403") && l.includes("forbidden.example.com:443") && l.includes("host_not_allowed"))
    && proxyLogs.some((l) => l.includes("REFUSED 403") && l.includes("allowed.supabase.co:8443") && l.includes("port_not_443")),
    proxyLogs);

  const proxyPids = [...s.bridgePids];
  await s.stop();
  check("proxy and bridge processes are gone after session stops", proxyPids.every((p) => !alive(p)), proxyPids);
  allowedTarget.close();
  forbiddenTarget.close();
}

// --- 4. isolation off (gates.network_isolation=false): host mode -----------
console.log("isolation off");
{
  const stateFile = path.join(tmp("autopilot-appnet-hw-"), "state.json");
  const r = await startAppSession({cfg: appCfg({}, {FIXTURE_STATE_FILE: stateFile}), repo, networkIsolation: false});
  check("host mode starts", r.ok === true && r.session.mode === "host" && r.session.joinPrefix === null, r);
  check("no namespace holder exists", r.session.holderPid === null && holdersOfThisProcess().length === 0);
  await r.session.stop();
  check("host mode server stopped", !alive(JSON.parse(fs.readFileSync(stateFile, "utf8")).pid));
}

// --- 5. brief note ----------------------------------------------------------
console.log("verifier brief");
{
  const r = await startAppSession({cfg: appCfg(), repo, networkIsolation: true});
  const note = verifierAppNote(r.session);
  check("note carries APP_BASE_URL and says the server is already running", note.includes(`APP_BASE_URL=http://127.0.0.1:${r.session.port}`) && /already running/.test(note), note);
  check("note says it is not on the host loopback", /NOT on the host loopback/.test(note), note);
  await r.session.stop();
  check("no note once the session is stopped, or without a server", verifierAppNote(r.session) === "" && verifierAppNote(null) === "");
}

// --- 6. config validation ---------------------------------------------------
console.log("config allow_hosts");
{
  const errs = (b) => { const e = []; validateAppServerConfig(b, "tests.app_server", e); return e; };
  check("a host name validates", errs({allow_hosts: ["abcd.supabase.co"]}).length === 0);
  check("scheme, port or path are rejected", errs({allow_hosts: ["https://a.co"]}).length === 1 && errs({allow_hosts: ["a.co:443"]}).length === 1 && errs({allow_hosts: ["a.co/x"]}).length === 1);
  check("a non-array is rejected", errs({allow_hosts: "a.co"}).length === 1);
}

// --- 7. the real gates() + verifier relay ------------------------------------
function runDriver(mode, {appServer = {}, command, isolation = true, noServer = false, detach = false} = {}) {
  const work = tmp("autopilot-appnet-drv-");
  const rp = tmp("autopilot-appnet-drvrepo-");
  spawnSync("git", ["init", "-q", rp]);
  const stateFile = path.join(work, "state.json");
  const cfg = {gates: {
    commands: [command || `node -e "fetch(process.env.APP_BASE_URL+'/hello').then(r=>console.log('GATE-STATUS',r.status))"`],
    network_isolation: isolation,
    ...(noServer ? {} : {app_server: appCfg(appServer, {FIXTURE_STATE_FILE: stateFile})}),
  }};
  const cfgFile = path.join(work, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const env = {...process.env, DECOY_PORT: String(decoyPort)};
  if (detach) return {child: spawn(process.execPath, [DRIVER, cfgFile, mode], {cwd: rp, env, stdio: ["ignore", "pipe", "pipe"]}), stateFile};
  const r = spawnSync(process.execPath, [DRIVER, cfgFile, mode], {cwd: rp, env, encoding: "utf8", timeout: 120000});
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
  return {out: line ? JSON.parse(line.slice(7)) : null, stdout: r.stdout, stderr: r.stderr, stateFile, status: r.status};
}
const serverGone = (stateFile) => { try { return !alive(JSON.parse(fs.readFileSync(stateFile, "utf8")).pid); } catch { return false; } };

console.log("gate keeps the namespace for the verifier");
{
  const d = runDriver("verify-ok");
  const o = d.out;
  check("driver produced a result", !!o, d.stdout + d.stderr);
  check("gate command ran isolated inside the namespace and reached the server", /GATE-STATUS 200/.test(o?.gateTail || "") && o?.gateOk === true, o);
  check("the session is still up after the gate (holder alive, server answers)", o?.sessionAfterGate === true && o?.afterGate?.server === 200, o);
  check("the verifier relay joined the same holder and namespace and reaches the server", o?.inRelay?.server === 200 && o?.holderPidRelay === o?.holderPid && o?.inRelay?.ns === o?.afterGate?.ns, o);
  check("verifier side: decoy and outside network unreachable", o?.inRelay?.decoy === "ECONNREFUSED" && ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(o?.inRelay?.outside), o?.inRelay);
  check("the verifier brief carries APP_BASE_URL and the already-running line", /APP_BASE_URL=http:\/\/127\.0\.0\.1:\d+/.test(o?.brief || "") && /already running/.test(o?.brief || ""), o?.brief);
  check("the session is released after the verifier", o?.sessionAfterVerifier === false);
  check("server and holder are gone afterwards", serverGone(d.stateFile) && !alive(o?.holderPid ?? 0));
  check("log says server, gate and verifier share one namespace", /network namespace ready/.test(d.stdout) && /stopped \(port \d+ free, namespace holder \d+ gone\)/.test(d.stdout), d.stdout.slice(-400));
}
{
  const d = runDriver("gate-only", {command: `node -e "const net=require('net');const c=net.connect({host:'127.0.0.1',port:${decoyPort},timeout:2000});c.on('connect',()=>console.log('DECOY connected'));c.on('error',e=>console.log('DECOY',e.code));c.on('timeout',()=>{console.log('DECOY timeout');c.destroy()})"`});
  check("gate command cannot reach a host-loopback decoy (isolation stays on)", /DECOY ECONNREFUSED/.test(d.out?.gateTail || "") && decoyHits === 0, d.out);
  check("gate-only run stops the server and holder", d.out?.sessionAfterGate === false && serverGone(d.stateFile) && holdersOfThisProcess().length === 0);
}
{
  const d = runDriver("verify-throw");
  check("verifier failure still releases the session", d.out?.thrown === "verifier crashed on purpose" && d.out?.sessionAfterVerifier === false && serverGone(d.stateFile) && !alive(d.out?.holderPid ?? 0), d.out);
}
{
  const d = runDriver("verify-ok", {command: "exit 1"});
  check("a red gate stops the session at once; the verifier starts a fresh one", d.out?.gateOk === false && d.out?.sessionAfterGate === false && d.out?.inRelay?.server === 200 && d.out?.sessionAfterVerifier === false, d.out);
}
{
  const d = runDriver("verify-dead-holder");
  check("a dead retained namespace holder is detected before verifier use", d.out?.staleSessionDetected === true, d.out);
  check("the verifier replaces a dead retained holder with a fresh live session",
    d.out?.inRelay?.server === 200
    && Number.isInteger(d.out?.holderPidRelay)
    && d.out.holderPidRelay !== d.out.holderPid
    && d.out?.sessionAfterVerifier === false,
    d.out);
  check("dead-holder replacement still cleans up the server and fresh holder",
    serverGone(d.stateFile) && !alive(d.out?.holderPidRelay ?? 0), d.out);
}
{
  const d = runDriver("verify-reused");
  check("gate reused: the verifier run starts the server itself and then stops it", d.out?.inRelay?.server === 200 && /APP_BASE_URL=/.test(d.out?.brief || "") && d.out?.sessionAfterVerifier === false && serverGone(d.stateFile), d.out);
}
{
  const d = runDriver("no-server", {noServer: true});
  check("no app_server: the brief is passed through unchanged", d.out?.brief === "verify the phase" && !("inRelay" in (d.out || {})), d.out);
}
{
  const d = runDriver("verify-ok", {appServer: {start_command: "exit 4"}});
  check("server start failure: gate fails, nothing is left, verifier gets no server note", d.out?.gateOk === false && !/APP_BASE_URL=http/.test(d.out?.brief || "") && holdersOfThisProcess().length === 0, d.out);
}
{
  const d = runDriver("verify-ok", {appServer: {allow_hosts: ["demo.supabase.co"]}});
  check("allow_hosts through the real gate: gate reaches the server via the bridge", d.out?.gateOk === true && /GATE-STATUS 200/.test(d.out?.gateTail || "") && d.out?.inRelay?.server === 200, d.out);
  check("allow_hosts: server and holder gone afterwards", serverGone(d.stateFile) && !alive(d.out?.holderPid ?? 0));
}
{
  const d = runDriver("verify-ok", {isolation: false});
  check("isolation off: gate and verifier still work with the host server (as before)", d.out?.gateOk === true && /GATE-STATUS 200/.test(d.out?.gateTail || "") && serverGone(d.stateFile), d.out);
}

console.log("SIGTERM during the verifier run");
{
  const {child, stateFile} = runDriver("verify-hang", {detach: true});
  let buf = "";
  child.stdout.on("data", (x) => { buf += x.toString(); });
  for (let i = 0; i < 400 && !/HANG-READY \d+/.test(buf); i++) await sleep(200);
  const holder = Number(/HANG-READY (\d+)/.exec(buf)?.[1]);
  check("the verifier run is in progress with a namespace holder", holder > 0 && alive(holder), buf.slice(-300));
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check("server is up during the verifier run", alive(st.pid));
  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
  await sleep(1500);
  check("server is gone after SIGTERM", !alive(st.pid));
  check("namespace holder is gone after SIGTERM", !alive(holder));
}

console.log("holder sustained lifetime, SIGKILL cleanup, and zero-zombie liveness");
{
  const stateFile = path.join(tmp("autopilot-appnet-long-"), "state.json");
  const r = await startAppSession({cfg: appCfg({}, {FIXTURE_STATE_FILE: stateFile}), repo, networkIsolation: true});
  check("long-window session starts", r.ok === true, r);
  if (r.ok) {
    const s = r.session;
    const hPid = s.holderPid;
    // Wait beyond multiple old 1-second polling windows to verify the holder
    // survives sustained idle periods without polling/fork churn or spurious exit.
    await sleep(3200);
    const holderStillAlive = s.alive() === true && alive(hPid);
    const p = probe(s);
    check("holder and namespace survive sustained idle window (>3s) and still isolate",
      holderStillAlive
      && p.server === 200
      && p.decoy === "ECONNREFUSED"
      && ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(p.outside),
      {holderStillAlive, p});
    // Verify the pipe-EOF holder does not fork periodic child processes (e.g. sleep 1).
    let childCount = 0;
    try {
      for (const d of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
          const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          if (ppid === hPid) childCount += 1;
        } catch {}
      }
    } catch {}
    check("pipe-EOF holder runs without periodic child fork churn", childCount === 0, {childCount});
    await s.stop();
    check("long-window session cleans up holder and server", !alive(hPid) && serverGone(stateFile));
  }

  // SIGKILL of an orchestrator process must tear down its pipe-EOF namespace
  // holder automatically even while an unrelated detached sibling stays alive.
  const sigkillScript = `
    import {spawn} from "node:child_process";
    import {startNamespaceHolder} from ${JSON.stringify(path.join(here, "app-net.mjs"))};
    const h = await startNamespaceHolder();
    if (h.error) { console.error(h.error); process.exit(2); }
    const sibling = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {detached: true, stdio: "ignore"});
    sibling.unref();
    console.log("SIGKILL_PIDS:" + h.pid + ":" + sibling.pid);
    setInterval(() => {}, 10000);
  `;
  const orch = spawn(process.execPath, ["--input-type=module", "-e", sigkillScript], {stdio: ["ignore", "pipe", "pipe"]});
  let orchOut = "";
  orch.stdout.on("data", (d) => { orchOut += d.toString("utf8"); });
  for (let i = 0; i < 100 && !/SIGKILL_PIDS:\d+:\d+/.test(orchOut); i++) await sleep(50);
  const m = /SIGKILL_PIDS:(\d+):(\d+)/.exec(orchOut);
  const hPid = Number(m?.[1] || 0);
  const siblingPid = Number(m?.[2] || 0);
  check("orchestrator child started holder and detached sibling", hPid > 0 && siblingPid > 0 && alive(hPid) && alive(siblingPid), {orchOut, hPid, siblingPid});
  if (orch.pid) { try { process.kill(orch.pid, "SIGKILL"); } catch {} }
  await new Promise((r) => orch.on("close", r));
  const deadUntil = Date.now() + 3000;
  while (hPid && alive(hPid) && Date.now() < deadUntil) await sleep(50);
  check("holder exits automatically after orchestrator SIGKILL even with detached sibling alive",
    hPid > 0 && !alive(hPid) && alive(siblingPid),
    {holderAlive: hPid ? alive(hPid) : null, siblingAlive: siblingPid ? alive(siblingPid) : null});
  if (siblingPid) { try { process.kill(siblingPid, "SIGKILL"); } catch {} }
  if (hPid) { try { process.kill(-hPid, "SIGKILL"); } catch {} }
}

decoy.close();
for (const d of tmpDirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
