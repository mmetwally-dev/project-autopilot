#!/usr/bin/env node
// Behavioral regression for the read-only envelope DNS-resolution fix.
//
// Root cause fixed: on hosts where /etc/resolv.conf is a symlink whose
// target lives outside every directory execution-envelope.mjs binds into
// the sandbox (WSL's /mnt/wsl/resolv.conf; systemd-resolved's
// /run/systemd/resolve/stub-resolv.conf, since /run is always a fresh
// empty --tmpfs), the read-only bubblewrap envelope silently lost DNS
// resolution — raw IP connectivity kept working (the network namespace is
// shared with the host via --share-net), but hostname lookups failed
// outright. A real agent CLI call inside the envelope manifested this as
// repeated api_retry events and a final "Request timed out" — not a review
// FAIL, not the (unrelated, out-of-scope) workspace-trust warning.
//
// This test proves, with REAL subprocesses inside the ACTUAL bubblewrap
// envelope (not code inspection), across two independent kinds of coverage:
//
// A. STRUCTURAL /etc regression coverage (section 1 below). Asserts the
//    shape of the sandbox's own /etc, which is what the fix actually
//    changed:
//      1. /etc/resolv.conf inside the sandbox is never a dangling symlink —
//         it is either the host's own working file (untouched fast path) or
//         the resolved real file bound fresh onto a clean mountpoint;
//      2. it contains at least one "nameserver" line;
//      3. sibling /etc entries needed for TLS (e.g. /etc/ssl) and NSS (e.g.
//         /etc/nsswitch.conf) remain present — the per-child rebind used
//         when the override triggers must not narrow /etc's exposure;
//      4. repository read-only containment is unaffected by the /etc change.
//
// B. DETERMINISTIC LOCAL DNS transport/resolution coverage (section 2
//    below). Asserts that a DNS query issued from inside the envelope
//    actually leaves the sandbox, reaches a server, and comes back with the
//    right answer — i.e. that --share-net really does give the sandbox
//    working DNS transport. The server is a minimal local UDP authoritative
//    fixture bound to 127.0.0.1 on an OS-assigned ephemeral port, answering
//    exactly one reserved name with one fixed address. No external
//    hostname, no public resolver, no internet, no privileged port, no
//    root, and nothing to be flaky about.
//
//    The two sections are deliberately independent. Section B configures
//    its own Node Resolver via setServers(), which BYPASSES
//    /etc/resolv.conf entirely — so section B must never be read as
//    evidence about resolv.conf. Section A is the sole authority on
//    resolv.conf's structure; section B is the sole authority on whether
//    DNS traffic works at all.
//
// Requires Linux/WSL (bubblewrap). Native Windows intentionally SKIPs (exit 0).
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {buildExecutionEnvelope, mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";
import {gitSnapshot, touchedFilesBetween} from "./relay-guards.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
};

if (process.platform === "win32") {
  console.log("test-execution-envelope-dns: SKIP — platform prerequisite not met: this proves DNS resolution inside the real read-only bubblewrap envelope, which requires Linux/WSL2 (bwrap) and does not exist on native Windows.");
  process.exit(0);
}

const lastJsonLine = (stdout, prefix) => {
  const lines = String(stdout || "").trim().split("\n");
  const line = lines.filter(l => l.startsWith(prefix)).at(-1);
  if (!line) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
};

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = args => spawnSync("git", args, {cwd: repo, encoding: "utf8", stdio: "pipe", env: withoutOuterGitGuard(process.env), shell: false});
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "envelope-dns-test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Envelope DNS Test"]).status, 0);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

// --------------------------------------------------------------------------
// Bounded ASYNCHRONOUS envelope runner.
//
// Section 2 must NOT use spawnSync: the local DNS fixture answers its query
// on this process's own event loop, and spawnSync would block that loop for
// the whole lifetime of the child — the query would arrive, sit unanswered,
// and the in-envelope resolver would time out. So the child is spawned
// asynchronously and awaited, with a hard kill deadline so a broken query can
// never hang the suite.
// --------------------------------------------------------------------------
function runEnvelope(envelope, childEnv, timeoutMs) {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(envelope.binary, envelope.args, {
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({status, signal, stdout, stderr, timedOut});
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      stderr += `spawn error: ${error && error.message ? error.message : error}`;
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
}

// --------------------------------------------------------------------------
// Minimal local authoritative DNS fixture (node:dgram only, no dependency).
//
// It understands exactly as much of RFC 1035 as this one assertion needs: a
// single-question query, echoed back with one A answer. Anything else is
// recorded and answered with the same fixed record — the parent asserts on
// what was actually observed, so a wrong name or wrong type fails loudly
// rather than being silently tolerated.
// --------------------------------------------------------------------------
const DNS_TYPE_A = 1;
const DNS_CLASS_IN = 1;

function parseDnsQuestion(message) {
  if (message.length < 12) return null;
  const id = message.readUInt16BE(0);
  const flags = message.readUInt16BE(2);
  if (message.readUInt16BE(4) !== 1) return null; // exactly one question
  const labels = [];
  let offset = 12;
  while (offset < message.length) {
    const length = message[offset];
    if (length === 0) { offset += 1; break; }
    if ((length & 0xc0) !== 0) return null; // compression is illegal in a question
    offset += 1;
    if (offset + length > message.length) return null;
    labels.push(message.toString("ascii", offset, offset + length));
    offset += length;
  }
  if (offset + 4 > message.length) return null;
  return {
    id,
    flags,
    name: labels.join("."),
    qtype: message.readUInt16BE(offset),
    qclass: message.readUInt16BE(offset + 2),
    questionEnd: offset + 4
  };
}

function buildDnsAnswer(message, question, ipv4) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(question.id, 0);
  // QR=1 (response), AA=1 (authoritative), RA=1, RCODE=0, RD echoed back.
  header.writeUInt16BE(0x8000 | 0x0400 | 0x0080 | (question.flags & 0x0100), 2);
  header.writeUInt16BE(1, 4);  // QDCOUNT
  header.writeUInt16BE(1, 6);  // ANCOUNT
  header.writeUInt16BE(0, 8);  // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT
  const questionSection = message.subarray(12, question.questionEnd);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);      // NAME: pointer to the question name at offset 12
  answer.writeUInt16BE(DNS_TYPE_A, 2);  // TYPE A
  answer.writeUInt16BE(DNS_CLASS_IN, 4);// CLASS IN
  answer.writeUInt32BE(60, 6);          // TTL
  answer.writeUInt16BE(4, 10);          // RDLENGTH
  const octets = ipv4.split(".");
  for (let i = 0; i < 4; i += 1) answer[12 + i] = Number(octets[i]);
  return Buffer.concat([header, questionSection, answer]);
}

// ==========================================================================
// 1. STRUCTURAL: /etc/resolv.conf shape, sibling /etc entries needed for TLS
//    and NSS, and repository containment — all in one subprocess probe.
//
//    This section is the sole authority on resolv.conf: section 2 installs
//    its own resolver with setServers() and therefore never reads
//    /etc/resolv.conf, so it proves nothing about it. These checks stay
//    exactly as they were.
// ==========================================================================
{
  const repo = makeRepo("ap-envelope-dns-");
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-envelope-dns-scratch-"));
  try {
    const probeSource = `
import fs from "node:fs";
const results = {};
try {
  const lst = fs.lstatSync("/etc/resolv.conf");
  results.isSymlink = lst.isSymbolicLink();
} catch (e) {
  results.isSymlink = "ERR:" + (e.code || e.message);
}
try {
  const text = fs.readFileSync("/etc/resolv.conf", "utf8");
  results.hasNameserverLine = text.split("\\n").some(l => l.trim().startsWith("nameserver"));
} catch (e) {
  results.hasNameserverLine = "ERR:" + (e.code || e.message);
}
results.etcSslPresent = fs.existsSync("/etc/ssl");
results.etcNsswitchPresent = fs.existsSync("/etc/nsswitch.conf");
try {
  fs.writeFileSync("/workspace/repository/tracked.txt", "tampered");
  results.repoWrite = "SUCCEEDED";
} catch (e) {
  results.repoWrite = "DENIED:" + (e.code || e.message);
}
results.repoContents = fs.readFileSync("/workspace/repository/tracked.txt", "utf8");
console.log("PROBE_RESULT=" + JSON.stringify(results));
`;
    const envelope = buildExecutionEnvelope({
      repo, scratchDir, readOnly: true, config: {},
      binary: process.execPath,
      args: ["--input-type=module", "-e", probeSource],
      permissionFiles: [],
      runtimeFiles: []
    });
    check("real read-only envelope is available on this plane", envelope.available === true, envelope.reason);
    if (envelope.available) {
      const before = gitSnapshot(repo);
      const childEnv = mapEnvironmentIntoEnvelope(process.env, envelope, repo, scratchDir);
      const r = spawnSync(envelope.binary, envelope.args, {encoding: "utf8", shell: false, timeout: 30000, env: childEnv});
      check("envelope probe exits 0", r.status === 0, r.stderr);
      const results = lastJsonLine(r.stdout, "PROBE_RESULT=") || {};
      check("/etc/resolv.conf inside the sandbox is never a dangling symlink", results.isSymlink === false, JSON.stringify(results.isSymlink));
      check("/etc/resolv.conf has at least one nameserver line", results.hasNameserverLine === true, JSON.stringify(results.hasNameserverLine));
      check("/etc/ssl remains present alongside the resolv.conf override", results.etcSslPresent === true);
      check("/etc/nsswitch.conf remains present alongside the resolv.conf override", results.etcNsswitchPresent === true);
      check("repository write attempt still denied immediately", /^DENIED:EROFS$/.test(results.repoWrite || ""), results.repoWrite);
      check("repository contents unchanged inside envelope", results.repoContents === "one");
      const after = gitSnapshot(repo);
      check("repository read-only containment preserved: host git snapshot unchanged", touchedFilesBetween(before, after, repo).length === 0);
      check("repository read-only containment preserved: host file unchanged", fs.readFileSync(path.join(repo, "tracked.txt"), "utf8") === "one");
    }
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(scratchDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// 2. DNS transport and resolution work from inside the envelope, proven
//    end-to-end against a LOCAL deterministic authoritative server.
//
//    This is the direct regression check for the observed failure: the agent
//    CLI's API calls timed out inside the envelope because DNS from the
//    sandbox did not work at all. Previously this section resolved a public
//    hostname, which made the whole suite depend on internet access and a
//    third party's availability — a network outage failed the suite even
//    when execution-envelope.mjs was perfectly correct. It now proves the
//    same property with zero external dependencies.
//
//    Deliberate choices:
//      * hostname `autopilot-dns.test` — `.test` is reserved by RFC 6761
//        precisely for this, so the name can never collide with or leak to
//        real DNS;
//      * address 192.0.2.123 — TEST-NET-1 (RFC 5737), documentation-only and
//        never routable;
//      * bound to 127.0.0.1 port 0, so the OS assigns an unprivileged
//        ephemeral port: no port-53 privilege, no root, no fixed port to
//        collide with a parallel run;
//      * a dedicated Resolver + setServers() rather than dns.lookup(),
//        because lookup() goes through libc/getaddrinfo and would ignore
//        setServers() entirely — it would silently query the system
//        resolver, which is exactly the external dependency being removed.
//
//    Note on scope: setServers() means this section does NOT consult
//    /etc/resolv.conf. It is not evidence about resolv.conf, and section 1
//    above is not evidence about DNS transport. Both are needed.
// ==========================================================================
{
  const DNS_HOSTNAME = "autopilot-dns.test";
  const DNS_ANSWER = "192.0.2.123";
  const observedQueries = [];
  let socket = null;
  let repo = null;
  let scratchDir = null;
  try {
    socket = dgram.createSocket("udp4");
    socket.on("message", (message, remote) => {
      const question = parseDnsQuestion(message);
      if (!question) return;
      observedQueries.push({name: question.name, qtype: question.qtype, qclass: question.qclass, from: remote.address});
      socket.send(buildDnsAnswer(message, question, DNS_ANSWER), remote.port, remote.address);
    });
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", resolve);
    });
    const dnsPort = socket.address().port;
    check("local DNS fixture bound to an unprivileged ephemeral port on 127.0.0.1",
      socket.address().address === "127.0.0.1" && dnsPort > 1024,
      JSON.stringify(socket.address()));

    repo = makeRepo("ap-envelope-dns-resolve-");
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-envelope-dns-resolve-scratch-"));

    // The probe also re-attempts a repository write. A DENIED:EROFS proves
    // the resolver call really executed inside the read-only bubblewrap
    // envelope rather than on the host by accident.
    const probeSource = `
import fs from "node:fs";
import {Resolver} from "node:dns/promises";
const out = {};
try {
  fs.writeFileSync("/workspace/repository/tracked.txt", "tampered");
  out.repoWrite = "SUCCEEDED";
} catch (e) {
  out.repoWrite = "DENIED:" + (e.code || e.message);
}
const resolver = new Resolver({timeout: 5000, tries: 2});
resolver.setServers([${JSON.stringify(`127.0.0.1:${dnsPort}`)}]);
out.servers = resolver.getServers();
try {
  out.addresses = await resolver.resolve4(${JSON.stringify(DNS_HOSTNAME)});
} catch (e) {
  out.resolveError = String((e && e.code) || e);
}
console.log("DNS_PROBE_RESULT=" + JSON.stringify(out));
`;
    const envelope = buildExecutionEnvelope({
      repo, scratchDir, readOnly: true, config: {},
      binary: process.execPath,
      args: ["--input-type=module", "-e", probeSource],
      permissionFiles: [],
      runtimeFiles: []
    });
    check("resolver envelope is available", envelope.available === true, envelope.reason);
    if (envelope.available) {
      const childEnv = mapEnvironmentIntoEnvelope(process.env, envelope, repo, scratchDir);
      const r = await runEnvelope(envelope, childEnv, 30000);
      const results = lastJsonLine(r.stdout, "DNS_PROBE_RESULT=") || {};

      check("resolver probe exits 0", r.status === 0, `status=${r.status} signal=${r.signal} stderr=${r.stderr}`);
      check("resolver probe did not hit the deadline", r.timedOut === false);
      check("resolver probe ran inside the real read-only envelope (repository write denied)",
        /^DENIED:EROFS$/.test(results.repoWrite || ""), results.repoWrite);
      check("in-envelope resolver targeted only the local fixture",
        Array.isArray(results.servers) && results.servers.length === 1 && results.servers[0] === `127.0.0.1:${dnsPort}`,
        JSON.stringify(results.servers));
      check("no resolver error inside the envelope", results.resolveError === undefined, results.resolveError);
      check(`local DNS fixture received a query for ${DNS_HOSTNAME}`,
        observedQueries.some(q => q.name === DNS_HOSTNAME), JSON.stringify(observedQueries));
      check("the observed query type is A",
        observedQueries.some(q => q.name === DNS_HOSTNAME && q.qtype === DNS_TYPE_A && q.qclass === DNS_CLASS_IN),
        JSON.stringify(observedQueries));
      check("the query reached the fixture over loopback from inside the sandbox",
        observedQueries.every(q => q.from === "127.0.0.1"), JSON.stringify(observedQueries));
      check("the fixture was asked for nothing except the reserved test name",
        observedQueries.length > 0 && observedQueries.every(q => q.name === DNS_HOSTNAME),
        JSON.stringify(observedQueries));
      check(`in-envelope resolver received exactly ${DNS_ANSWER}`,
        Array.isArray(results.addresses) && results.addresses.length === 1 && results.addresses[0] === DNS_ANSWER,
        JSON.stringify(results.addresses));
    }
  } finally {
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (repo) fs.rmSync(repo, {recursive: true, force: true});
    if (scratchDir) fs.rmSync(scratchDir, {recursive: true, force: true});
  }
}

// ---- Section C: external adapter + permission file + runtime helper coexist ----
// (moved from the removed test-execution-plane-safety.mjs). Real bubblewrap
// run; SKIPs when no envelope is available on this host.
{
  const strictConfig = {
    gates: {network_isolation: true},
    capabilities: {execution_plane_safety: {required: true, require_filesystem_boundary: true, require_process_containment: true, browser_network_policy: "separate", network: {external_egress: "deny", loopback: "controlled"}}}
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-envelope-coexist-"));
  try {
    const scratch = path.join(root, "scratch");
    fs.mkdirSync(scratch, {recursive: true});
    const externalAdapter = path.join(root, "external-adapter");
    const runtimeHelper = path.join(root, "runtime-helper");
    const permissionFile = path.join(root, "adapter-permission.json");
    fs.writeFileSync(externalAdapter, "#!/bin/sh\n/autopilot/bin/runtime-helper\nprintf external-adapter-ok\n");
    fs.chmodSync(externalAdapter, 0o755);
    fs.writeFileSync(runtimeHelper, "#!/bin/sh\nprintf runtime-helper-ok\\n\n");
    fs.chmodSync(runtimeHelper, 0o755);
    fs.writeFileSync(permissionFile, "{}");
    const adapterEnvelope = buildExecutionEnvelope({repo: root, scratchDir: scratch, readOnly: true, config: strictConfig, binary: externalAdapter, args: [], permissionFiles: [permissionFile], runtimeFiles: [runtimeHelper]});
    if (!adapterEnvelope.available) {
      console.log(`SKIP coexistence: envelope unavailable on this host (${adapterEnvelope.reason})`);
    } else {
      const adapterProbe = spawnSync(adapterEnvelope.binary, adapterEnvelope.args, {cwd: adapterEnvelope.cwd, encoding: "utf8", shell: false});
      check("external adapter and permission mounts coexist (exit 0)", adapterProbe.status === 0, adapterProbe.stderr);
      check("runtime helper ran inside the envelope", /runtime-helper-ok/.test(adapterProbe.stdout));
      check("external adapter ran inside the envelope", /external-adapter-ok/.test(adapterProbe.stdout));
      const missingRuntime = buildExecutionEnvelope({repo: root, scratchDir: scratch, readOnly: true, config: strictConfig, binary: externalAdapter, args: [], runtimeFiles: [path.join(root, "missing-runtime-helper")]});
      check("missing runtime file denies the envelope with adapter_runtime_file_missing",
        missingRuntime.available === false && missingRuntime.reason === "adapter_runtime_file_missing", missingRuntime.reason);
    }
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} execution-envelope DNS check(s) failed.`);
  process.exit(1);
}
console.log("test-execution-envelope-dns: ALL CHECKS PASSED");
