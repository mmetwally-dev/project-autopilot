#!/usr/bin/env node
// networkIsolationPrefix() must bring loopback up INSIDE the isolated
// namespace (test-execution-envelope-dns's 127.0.0.1 DNS fixture failed
// there before), while the namespace stays isolated, and must degrade to
// today's prefix (command still runs) when `ip` is missing/fails.
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {networkIsolationPrefix} from "./shell-guard.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const prefix = networkIsolationPrefix();
check("networkIsolationPrefix available on this machine", prefix !== null, String(prefix));
if (!prefix) { console.log("test-network-isolation-loopback: SKIP — isolation unavailable"); process.exit(0); }
check("prefix brings loopback up inside the namespace", prefix.some(p => p.includes("ip link set lo up")), JSON.stringify(prefix));

// 1. A TCP server on 127.0.0.1 inside the namespace is reachable from
//    inside it, and 127.0.0.1 is the only interface address.
{
  const script = `
const net = require("node:net");
const os = require("node:os");
const ifaces = Object.values(os.networkInterfaces()).flat().map(i => i.address);
const nonLoopback = ifaces.filter(a => a !== "127.0.0.1" && a !== "::1");
if (nonLoopback.length) { console.log("NONLOOPBACK:" + nonLoopback.join(",")); process.exit(2); }
const srv = net.createServer(c => c.end("hello-loopback"));
srv.listen(0, "127.0.0.1", () => {
  const port = srv.address().port;
  const sock = net.connect(port, "127.0.0.1");
  sock.on("data", d => { console.log("LOOPBACK_OK:" + d); srv.close(); process.exit(0); });
  sock.on("error", e => { console.log("LOOPBACK_FAIL:" + e.code); process.exit(1); });
});
srv.on("error", e => { console.log("SERVER_FAIL:" + e.code); process.exit(1); });
`;
  const r = spawnSync(prefix[0], [...prefix.slice(1), process.execPath, "-e", script], {encoding: "utf8", timeout: 30000});
  check("loopback server reachable inside namespace; only lo addresses present", r.status === 0 && (r.stdout || "").includes("LOOPBACK_OK:hello-loopback"), {status: r.status, stdout: (r.stdout || "").slice(0, 120), stderr: (r.stderr || "").slice(-120)});
}

// 2. An outside address is still unreachable.
{
  const script = `
const net = require("node:net");
const s = net.connect(443, "1.1.1.1");
s.setTimeout(2000);
s.on("connect", () => { console.log("OUTSIDE_REACHED"); process.exit(2); });
s.on("timeout", () => { console.log("TIMEOUT"); process.exit(0); });
s.on("error", e => { console.log("ERROR:" + e.code); process.exit(0); });
`;
  const r = spawnSync(prefix[0], [...prefix.slice(1), process.execPath, "-e", script], {encoding: "utf8", timeout: 30000});
  check("outside address unreachable from the isolated namespace", r.status === 0, {status: r.status, stdout: (r.stdout || "").slice(0, 120), stderr: (r.stderr || "").slice(-120)});
}

// 3. With `ip` unavailable (fake PATH without it), the prefix degrades to
//    today's form and the command still runs.
{
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "fakebin-"));
  for (const tool of ["sh", "unshare", "node", "env", "true", "false"]) {
    const real = spawnSync("sh", ["-c", `which ${tool}`], {encoding: "utf8"}).stdout.trim().split("\n")[0];
    try { fs.symlinkSync(real, path.join(fake, tool)); } catch {}
  }
  const oldPATH = process.env.PATH;
  process.env.PATH = fake;
  try {
    const p2 = networkIsolationPrefix();
    check("fake PATH without ip: prefix degrades to today's form", p2 !== null && !p2.includes("ip link set lo up"), JSON.stringify(p2));
    const r = spawnSync(p2[0], [...p2.slice(1), "sh", "-lc", "echo still-runs"], {encoding: "utf8", timeout: 30000});
    check("fake PATH without ip: command still runs", r.status === 0 && (r.stdout || "").includes("still-runs"), {status: r.status, stderr: (r.stderr || "").slice(-120)});
  } finally {
    process.env.PATH = oldPATH;
  }
}

console.log(failures === 0 ? "test-network-isolation-loopback: OK" : `test-network-isolation-loopback: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
