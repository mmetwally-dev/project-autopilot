#!/usr/bin/env node
// TASK 15.5A — focused behavioral tests for runtime-mode capability discovery.
// Discovery only: asserts structured capability behavior, never prompt prose.
// Mocks only the OS subprocess boundary (spawnFn) for deterministic failure
// variants; plus one real read-only discovery probe (no distro-name dependence).
import {spawn as nodeSpawn} from "node:child_process";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNTIME_MODE_IDS,
  RUNTIME_STRENGTH,
  SUPPORTED_FRAMEWORKS_ALL,
  SUPPORTED_FRAMEWORKS_SPECKIT_ONLY,
  detectRuntimeModeCapabilities,
  discoverUsableWslDistro,
  decodeWslDistroListBytes,
  classifyWslKernelEvidence,
  runBoundedProbeTree,
  __testables
} from "./runtime-mode-capabilities.mjs";
import {PLATFORM_KINDS} from "./platform-capabilities.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 2000)}` : ""}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = signal => { child.killCalls.push(signal); return true; };
  child.pid = 999999;
  return child;
}

function modeById(result, id) {
  return result.modes.find(m => m.id === id);
}

function assertModeShape(mode) {
  return mode
    && typeof mode.id === "string"
    && typeof mode.available === "boolean"
    && (mode.strength === "strong" || mode.strength === "compatibility")
    && Array.isArray(mode.supportedFrameworks)
    && ("reason" in mode)
    && ("distro" in mode);
}

const WSL2_KERNEL = "6.18.33.2-microsoft-standard-WSL2";
const WSL1_KERNEL = "4.4.0-19041-Microsoft";

function utf8ListBytes(names) {
  return Buffer.from(names.join("\r\n") + (names.length ? "\r\n" : ""), "utf8");
}
function utf16leListBytes(names, withBom = true) {
  const text = names.join("\r\n") + (names.length ? "\r\n" : "");
  const body = Buffer.from(text, "utf16le");
  if (withBom) return Buffer.concat([Buffer.from([0xFF, 0xFE]), body]);
  return body;
}

// Build a mocked wsl.exe spawn covering list + per-distro kernel/node/bwrap.
// behavior: { listBytes: Buffer|null, listKind, distros: { [name]: { kernel, node, bwrapVersion, bwrapSandbox } } }
// Each probe entry: "ok" | "missing-node" | "missing-bwrap" | "broken-bwrap" | "wsl1" | "hang" | "broken-kernel" | "malformed-node"
function makeWslMock({listBytes, listKind = "ok", distroBehavior = {}, hangProbe = null, calls = null, shellCheck = null}) {
  return (binary, args, opts) => {
    if (calls) calls.push({binary, args, opts});
    if (shellCheck) shellCheck(opts);
    const child = fakeChild();
    queueMicrotask(() => {
      // List probe
      if (args.length === 2 && args[0] === "--list" && args[1] === "--quiet") {
        if (hangProbe === "list") return; // never settles -> timeout path
        if (listKind === "missing") { child.emit("error", {code: "ENOENT", message: "spawn wsl.exe ENOENT"}); return; }
        if (listKind === "broken") { child.stderr.emit("data", Buffer.from("wsl failed")); child.emit("close", 1, null); return; }
        if (listKind === "timeout-sim") { child.emit("close", 1, null); return; }
        child.stdout.emit("data", listBytes || Buffer.alloc(0));
        child.emit("close", 0, null);
        return;
      }
      // Per-distro probes: ["-d", distro, "--", ...cmd]
      const distro = args[1];
      const cmd = args.slice(3);
      const behavior = distroBehavior[distro] || {};
      const cmdKey = cmd[0] === "uname" ? "kernel" : cmd[0] === "/usr/bin/node" ? "node" : cmd[0] === "bwrap" && cmd[1] === "--version" ? "bwrapVersion" : cmd[0] === "bwrap" ? "bwrapSandbox" : "unknown";
      if (hangProbe === cmdKey || behavior[cmdKey] === "hang") return;
      if (cmdKey === "kernel") {
        if (behavior.kernel === "wsl1") { child.stdout.emit("data", Buffer.from(WSL1_KERNEL + "\n")); child.emit("close", 0, null); return; }
        if (behavior.kernel === "broken") { child.stderr.emit("data", Buffer.from("failed")); child.emit("close", 1, null); return; }
        if (behavior.kernel === "malformed") { child.stdout.emit("data", Buffer.from("\n")); child.emit("close", 0, null); return; }
        child.stdout.emit("data", Buffer.from(WSL2_KERNEL + "\n"));
        child.emit("close", 0, null);
        return;
      }
      if (cmdKey === "node") {
        if (behavior.node === "missing") { child.stderr.emit("data", Buffer.from("/usr/bin/node: No such file or directory")); child.emit("close", 127, null); return; }
        if (behavior.node === "broken") { child.stderr.emit("data", Buffer.from("node crashed")); child.emit("close", 1, null); return; }
        if (behavior.node === "malformed") { child.stdout.emit("data", Buffer.from("not-a-version\n")); child.emit("close", 0, null); return; }
        child.stdout.emit("data", Buffer.from("v22.22.1\n"));
        child.emit("close", 0, null);
        return;
      }
      if (cmdKey === "bwrapVersion") {
        if (behavior.bwrapVersion === "missing") { child.stderr.emit("data", Buffer.from("bwrap: command not found")); child.emit("close", 127, null); return; }
        if (behavior.bwrapVersion === "broken") { child.stderr.emit("data", Buffer.from("bwrap failed")); child.emit("close", 1, null); return; }
        child.stdout.emit("data", Buffer.from("bubblewrap 0.11.1\n"));
        child.emit("close", 0, null);
        return;
      }
      if (cmdKey === "bwrapSandbox") {
        if (behavior.bwrapSandbox === "broken") { child.stderr.emit("data", Buffer.from("bwrap: Creating new namespace failed: Operation not permitted")); child.emit("close", 1, null); return; }
        child.emit("close", 0, null);
        return;
      }
      child.stderr.emit("data", Buffer.from("unexpected mock command"));
      child.emit("close", 1, null);
    });
    return child;
  };
}

function makeBubblewrapMock({version = "ok", sandbox = "ok", calls = null}) {
  return (binary, args, opts) => {
    if (calls) calls.push({binary, args, opts});
    const child = fakeChild();
    queueMicrotask(() => {
      if (args[0] === "--version") {
        if (version === "missing") { child.emit("error", {code: "ENOENT", message: "spawn bwrap ENOENT"}); return; }
        if (version === "broken") { child.stderr.emit("data", Buffer.from("bwrap failed")); child.emit("close", 1, null); return; }
        if (version === "hang") return;
        child.stdout.emit("data", Buffer.from("bubblewrap 0.8.0\n"));
        child.emit("close", 0, null);
        return;
      }
      if (sandbox === "broken") { child.stderr.emit("data", Buffer.from("bwrap: Creating new namespace failed")); child.emit("close", 1, null); return; }
      if (sandbox === "hang") return;
      child.emit("close", 0, null);
    });
    return child;
  };
}

// ---------------------------------------------------------------------
// Unit: kernel classification + distro-list decoding
// ---------------------------------------------------------------------
check("classifies WSL2 kernel as wsl2", classifyWslKernelEvidence(WSL2_KERNEL) === PLATFORM_KINDS.wsl2);
check("classifies WSL1 kernel as wsl1", classifyWslKernelEvidence(WSL1_KERNEL) === PLATFORM_KINDS.wsl1);
check("classifies older microsoft-standard as wsl2", classifyWslKernelEvidence("4.19.84-microsoft-standard") === PLATFORM_KINDS.wsl2);
check("classifies generic linux as native-linux", classifyWslKernelEvidence("6.8.0-generic") === PLATFORM_KINDS.nativeLinux);

{
  const parsed = decodeWslDistroListBytes(utf8ListBytes(["Ubuntu", "Debian"]));
  check("utf-8 distro list parses two names", parsed.malformed === false && parsed.distros.length === 2 && parsed.distros[0] === "Ubuntu" && parsed.distros[1] === "Debian", parsed);
}
{
  const parsed = decodeWslDistroListBytes(utf16leListBytes(["Ubuntu", "Debian"], true));
  check("utf-16le distro list with BOM parses", parsed.malformed === false && parsed.distros.length === 2 && parsed.distros.includes("Ubuntu"), parsed);
}
{
  const parsed = decodeWslDistroListBytes(utf16leListBytes(["Ubuntu", "Debian"], false));
  check("utf-16le distro list without BOM parses", parsed.malformed === false && parsed.distros.length === 2, parsed);
}
{
  const parsed = decodeWslDistroListBytes(utf8ListBytes(["My Custom Distro", "Ubuntu 22.04"]));
  check("distro names containing spaces survive line-split", parsed.distros.includes("My Custom Distro") && parsed.distros.includes("Ubuntu 22.04"), parsed);
}
{
  const parsed = decodeWslDistroListBytes(utf16leListBytes(["My Custom Distro"], true));
  check("utf-16le distro name with spaces survives", parsed.distros[0] === "My Custom Distro", parsed);
}
{
  const parsed = decodeWslDistroListBytes(Buffer.alloc(0));
  check("empty list output is no distro, not malformed", parsed.malformed === false && parsed.distros.length === 0);
}

// ---------------------------------------------------------------------
// WSL2 current-process discovery
// ---------------------------------------------------------------------
{
  const calls = [];
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: makeBubblewrapMock({version: "ok", sandbox: "ok", calls}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("WSL2+usable bubblewrap: wsl2-strong available", strong.available === true && strong.strength === "strong", strong);
  check("WSL2+usable: version-only is insufficient (both probes ran)", calls.length === 2 && calls[0].args[0] === "--version", calls);
  check("WSL2+usable: linux-strong unavailable", modeById(result, RUNTIME_MODE_IDS.linuxStrong).available === false);
  check("WSL2+usable: windows-compatibility unavailable", modeById(result, RUNTIME_MODE_IDS.windowsCompatibility).available === false);
  check("WSL2+usable: recommendedMode is wsl2-strong", result.recommendedMode === RUNTIME_MODE_IDS.wsl2Strong, result);
  check("WSL2+usable: strong supports all frameworks", JSON.stringify(strong.supportedFrameworks.slice().sort()) === JSON.stringify([...SUPPORTED_FRAMEWORKS_ALL].slice().sort()), strong);
  check("WSL2 result has structured modes", result.modes.length === 3 && result.modes.every(assertModeShape), result);
  check("WSL2 probes use shell:false arg arrays", calls.every(c => c.opts?.shell === false && Array.isArray(c.args)), calls);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: makeBubblewrapMock({version: "missing"}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("WSL2+missing bubblewrap: unavailable", strong.available === false && /not_installed|missing/i.test(strong.reason || ""), strong);
  check("WSL2+missing: recommendedMode is null (never claims unavailable mode)", result.recommendedMode === null, result);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn: makeBubblewrapMock({version: "ok", sandbox: "broken"}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("WSL2+broken sandbox: unavailable (version-only never suffices)", strong.available === false && /unusable|broken/i.test(strong.reason || ""), strong);
  check("WSL2+broken: recommendedMode null", result.recommendedMode === null, result);
}

// ---------------------------------------------------------------------
// WSL1 current-process: rejected as strong mode
// ---------------------------------------------------------------------
{
  let spawned = false;
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.wsl1,
    spawn: () => { spawned = true; return fakeChild(); },
    timeoutMs: 5000
  });
  check("WSL1: wsl2-strong unavailable", modeById(result, RUNTIME_MODE_IDS.wsl2Strong).available === false);
  check("WSL1: linux-strong unavailable", modeById(result, RUNTIME_MODE_IDS.linuxStrong).available === false);
  check("WSL1: windows-compatibility unavailable", modeById(result, RUNTIME_MODE_IDS.windowsCompatibility).available === false);
  check("WSL1: recommendedMode null", result.recommendedMode === null, result);
  check("WSL1 rejected as strong mode with precise reason", /wsl1/i.test(modeById(result, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), modeById(result, RUNTIME_MODE_IDS.wsl2Strong));
}

// ---------------------------------------------------------------------
// Native Linux discovery
// ---------------------------------------------------------------------
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeLinux,
    spawn: makeBubblewrapMock({version: "ok", sandbox: "ok"}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.linuxStrong);
  check("Native Linux+usable: linux-strong available", strong.available === true && strong.strength === "strong", strong);
  check("Native Linux+usable: recommendedMode linux-strong", result.recommendedMode === RUNTIME_MODE_IDS.linuxStrong, result);
  check("Native Linux: wsl2-strong unavailable", modeById(result, RUNTIME_MODE_IDS.wsl2Strong).available === false);
  check("Native Linux: windows-compat unavailable", modeById(result, RUNTIME_MODE_IDS.windowsCompatibility).available === false);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeLinux,
    spawn: makeBubblewrapMock({version: "missing"}),
    timeoutMs: 5000
  });
  check("Native Linux without bubblewrap: unavailable", modeById(result, RUNTIME_MODE_IDS.linuxStrong).available === false);
  check("Native Linux without bubblewrap: recommendedMode null", result.recommendedMode === null, result);
}

// ---------------------------------------------------------------------
// Native Windows discovery variants
// ---------------------------------------------------------------------
{
  const calls = [];
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: (bin, args, opts) => {
      calls.push({binary: bin, args, opts});
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", {code: "ENOENT", message: "spawn wsl.exe ENOENT"}));
      return child;
    },
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  const compat = modeById(result, RUNTIME_MODE_IDS.windowsCompatibility);
  check("Windows without WSL: wsl2-strong unavailable missing-WSL", strong.available === false && /wsl_not_installed/i.test(strong.reason || ""), strong);
  check("Windows without WSL: compat available SpecKit-and-standalone", compat.available === true && compat.strength === "compatibility" && JSON.stringify(compat.supportedFrameworks) === JSON.stringify(["speckit", "standalone"]), compat);
  check("Windows compat explicitly not OS-enforced", /not OS-enforced/.test(compat.reason || ""), compat);
  check("Windows without WSL: recommendedMode is windows-compatibility", result.recommendedMode === RUNTIME_MODE_IDS.windowsCompatibility, result);
  check("Windows compat never lists gsd (standalone included)", !compat.supportedFrameworks.includes("gsd") && compat.supportedFrameworks.includes("standalone"), compat);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: Buffer.alloc(0)}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("Windows no distro: unavailable no_distro", strong.available === false && /no_distro/i.test(strong.reason || ""), strong);
  check("Windows no distro: recommendedMode compat", result.recommendedMode === RUNTIME_MODE_IDS.windowsCompatibility, result);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {kernel: "wsl1"}}}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("Windows WSL1-only: rejected as strong", strong.available === false && /wsl1_only/i.test(strong.reason || ""), strong);
  check("Windows WSL1-only: recommendedMode compat", result.recommendedMode === RUNTIME_MODE_IDS.windowsCompatibility, result);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {node: "missing"}}}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("Windows WSL2 missing /usr/bin/node: unavailable node reason", strong.available === false && /node_missing/i.test(strong.reason || ""), strong);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {bwrapVersion: "missing"}}}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("Windows WSL2 missing bubblewrap: unavailable", strong.available === false && /bubblewrap_not_installed/i.test(strong.reason || ""), strong);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {bwrapSandbox: "broken"}}}),
    timeoutMs: 5000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  check("Windows WSL2 broken bubblewrap: unavailable unusable", strong.available === false && /sandbox_unusable|unusable/i.test(strong.reason || ""), strong);
}
{
  const calls = [];
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), calls}),
    timeoutMs: 8000
  });
  const strong = modeById(result, RUNTIME_MODE_IDS.wsl2Strong);
  const compat = modeById(result, RUNTIME_MODE_IDS.windowsCompatibility);
  check("Windows usable distro: wsl2-strong available", strong.available === true && strong.distro === "Ubuntu", strong);
  check("Windows usable: recommendedMode wsl2-strong", result.recommendedMode === RUNTIME_MODE_IDS.wsl2Strong, result);
  check("Windows usable: compat remains available weaker alternative", compat.available === true && compat.strength === "compatibility", compat);
  check("Windows usable: list used --list --quiet (no heading dependence)", calls.length > 0 && calls[0].args[0] === "--list" && calls[0].args[1] === "--quiet", calls[0]);
  check("Windows usable: node probe uses /usr/bin/node", calls.some(c => c.args.includes("/usr/bin/node")), calls);
  check("Windows usable: sandbox probe proves usability (bwrap + true)", calls.some(c => c.args.includes("bwrap") && c.args.includes("true") && c.args.includes("--unshare-all")), calls);
  check("Windows usable: all probes shell:false", calls.every(c => c.opts?.shell === false), calls);
  check("Windows usable: never starts agent CLI", !calls.some(c => /claude|codex|opencode|cursor|gemini/i.test(String(c.binary))), calls);
  check("Windows usable: never mutates (no install or apt)", !calls.some(c => c.args.some(a => /--install|apt-get|apt install|mkfs/i.test(String(a)))), calls);
}

// ---------------------------------------------------------------------
// Deterministic selection + spaces + encodings
// ---------------------------------------------------------------------
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu", "Debian"])}),
    timeoutMs: 8000
  });
  check("multiple distros: deterministic sorted first wins (Debian before Ubuntu)", modeById(result, RUNTIME_MODE_IDS.wsl2Strong).distro === "Debian", result);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf16leListBytes(["Ubuntu", "Debian"], true)}),
    timeoutMs: 8000
  });
  check("utf-16le list: deterministic selection still holds", modeById(result, RUNTIME_MODE_IDS.wsl2Strong).distro === "Debian", result);
}
{
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["My Custom Distro"]), distroBehavior: {}}),
    timeoutMs: 8000
  });
  check("distro name with spaces: preserved exactly", modeById(result, RUNTIME_MODE_IDS.wsl2Strong).distro === "My Custom Distro", result);
}
{
  const calls = [];
  await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["My Custom Distro"]), calls}),
    timeoutMs: 8000
  });
  const distroArgs = calls.filter(c => c.args[0] === "-d").map(c => c.args[1]);
  check("distro with spaces passed as single argv element", distroArgs.length > 0 && distroArgs.every(d => d === "My Custom Distro"), distroArgs);
}
{
  // First sorted fails (WSL1), second succeeds -> second wins deterministically.
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({
      listBytes: utf8ListBytes(["Ubuntu", "Alpine"]),
      distroBehavior: {Alpine: {kernel: "wsl1"}}
    }),
    timeoutMs: 8000
  });
  check("sorted first unusable falls through to next usable", modeById(result, RUNTIME_MODE_IDS.wsl2Strong).distro === "Ubuntu", result);
}

// ---------------------------------------------------------------------
// Hanging probes + shared deadline + output limits + single settlement
// ---------------------------------------------------------------------
{
  // Hanging list probe
  const hanging = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), hangProbe: "list"}),
    timeoutMs: 400
  });
  check("hanging list probe: timeout reason", /timed_out|timeout/i.test(modeById(hanging, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), hanging);
  check("hanging list: recommendedMode falls back to compat", hanging.recommendedMode === RUNTIME_MODE_IDS.windowsCompatibility, hanging);
}
{
  const hangingKernel = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {kernel: "hang"}}}),
    timeoutMs: 600
  });
  check("hanging kernel probe: timeout", /timed_out|timeout/i.test(modeById(hangingKernel, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), hangingKernel);
}
{
  const hangingNode = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {node: "hang"}}}),
    timeoutMs: 800
  });
  // Node hang consumes shared deadline; with one distro the overall result is timeout.
  check("hanging node probe: timeout", /timed_out|timeout/i.test(modeById(hangingNode, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), hangingNode);
}
{
  const hangingBwrap = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"]), distroBehavior: {Ubuntu: {bwrapSandbox: "hang"}}}),
    timeoutMs: 800
  });
  check("hanging bubblewrap probe: timeout", /timed_out|timeout/i.test(modeById(hangingBwrap, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), hangingBwrap);
}
{
  // Shared deadline exhaustion: version consumes whole budget, sandbox never spawned.
  let clock = 1_000_000;
  const now = () => clock;
  let sandboxCalls = 0;
  const spawn = (bin, args) => {
    const child = fakeChild();
    if (args[0] === "--version") {
      clock += 500;
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from("bubblewrap 0.8.0\n")); child.emit("close", 0, null); });
    } else {
      sandboxCalls += 1;
      queueMicrotask(() => child.emit("close", 0, null));
    }
    return child;
  };
  const result = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.wsl2,
    spawn, now, timeoutMs: 500
  });
  check("shared deadline exhaustion: second probe not spawned", sandboxCalls === 0, {sandboxCalls});
  check("shared deadline exhaustion: timeout reported", /timed_out|timeout/i.test(modeById(result, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), result);
}
{
  // Output limits: 1MB child output bounded to cap.
  const big = await runBoundedProbeTree(
    (bin, args, opts) => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.alloc(1000000, "Y"));
        child.emit("close", 0, null);
      });
      return child;
    },
    "wsl.exe", ["--list", "--quiet"],
    {deadline: Date.now() + 5000, now: () => Date.now(), killGraceMs: 200, maxOutputBytes: 1024}
  );
  check("output limits: stdout bounded by bytes", big.stdoutBytes.length <= 1024, {len: big.stdoutBytes.length});
  check("output limits: overflow flagged", big.outputLimitExceeded === true, big);
}
{
  // Single settlement: error then contradictory close -> error wins.
  const single = await runBoundedProbeTree(
    () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit("error", {code: "ENOENT", message: "spawn bwrap ENOENT"});
        child.emit("close", 0, null);
      });
      return child;
    },
    "bwrap", ["--version"],
    {deadline: Date.now() + 5000, now: () => Date.now(), killGraceMs: 200}
  );
  check("single settlement: first event wins", single.kind === "missing", single);
}
{
  // Process-tree cleanup: real SIGTERM-ignoring child must be reaped.
  const ignoreScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  let capturedPid = null;
  let spawnCount = 0;
  const start = Date.now();
  const res = await runBoundedProbeTree(
    (bin, args, opts) => {
      spawnCount += 1;
      const child = nodeSpawn(process.execPath, ["-e", ignoreScript], opts);
      capturedPid = child.pid;
      return child;
    },
    "bwrap", ["--version"],
    {deadline: Date.now() + 400, now: () => Date.now(), killGraceMs: 200, maxOutputBytes: 4096}
  );
  const elapsed = Date.now() - start;
  check("process-tree cleanup: timeout reported", res.kind === "timeout", res);
  check("process-tree cleanup: bounded time", elapsed < 8000, {elapsed});
  check("process-tree cleanup: only one probe spawned", spawnCount === 1, {spawnCount});
  await new Promise(r => setTimeout(r, 400));
  let stillRunning = true;
  try { process.kill(capturedPid, 0); } catch { stillRunning = false; }
  check("process-tree cleanup: no leaked subprocess", stillRunning === false, {pid: capturedPid});
}
{
  // Real POSIX regression for the exact missed bug: detached leader exits on
  // SIGTERM while a descendant ignores SIGTERM. Premature close settlement
  // would return as soon as the leader closes, leaking the descendant. The
  // corrected runner must wait through the SIGKILL phase, confirm group
  // death, and only then settle — with the descendant gone.
  if (process.platform === "win32") {
    console.log("skip: POSIX SIGTERM-ignoring descendant regression (not on win32)");
  } else {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "ap-posix-desc-"));
    const readyFile = path.join(tmpParent, "desc-ready");
    const descendantPidFile = path.join(tmpParent, "desc-pid");
    const descendantScript = path.join(tmpParent, "descendant.cjs");
    const leaderScript = path.join(tmpParent, "leader.cjs");
    fs.writeFileSync(descendantScript, [
      "const fs = require('node:fs');",
      "const readyFile = process.argv[2];",
      "const pidFile = process.argv[3];",
      "process.on('SIGTERM', () => {});",
      "fs.writeFileSync(pidFile, String(process.pid));",
      "fs.writeFileSync(readyFile, 'ready');",
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"));
    fs.writeFileSync(leaderScript, [
      "const {spawn} = require('node:child_process');",
      "const desc = spawn(process.execPath, [" + JSON.stringify(descendantScript) + ", " + JSON.stringify(readyFile) + ", " + JSON.stringify(descendantPidFile) + "], {stdio: 'ignore'});",
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"));
    let leaderPid = null;
    let emergencyPids = [];
    // Room for the leader + descendant node processes to start and write
    // the ready file on a loaded machine (1200ms was not enough under the
    // parallel suite).
    const timeoutMs = 5000;
    const killGraceMs = 500;
    const startTime = Date.now();
    const probePromise = runBoundedProbeTree(
      (bin, args, opts) => {
        const child = nodeSpawn(process.execPath, [leaderScript], opts);
        leaderPid = child.pid;
        emergencyPids = [leaderPid];
        return child;
      },
      "bwrap", ["--version"],
      {deadline: startTime + timeoutMs, now: () => Date.now(), killGraceMs, maxOutputBytes: 4096, confirmPollMs: 50, confirmAttempts: 12, backstopSlackMs: 1000}
    );
    let readyTime = null;
    try {
      const readyDeadline = Date.now() + 8000;
      while (!fs.existsSync(readyFile)) {
        if (Date.now() > readyDeadline) break;
        await new Promise(r => setTimeout(r, 50));
      }
      check("POSIX descendant: ready confirmation observed before settlement", fs.existsSync(readyFile), {tmpParent});
      readyTime = Date.now();
      check("POSIX descendant: ready before shared deadline fired", readyTime < startTime + timeoutMs, {readyTime, startTime, timeoutMs});
      const descPidText = fs.existsSync(descendantPidFile) ? fs.readFileSync(descendantPidFile, "utf8").trim() : "";
      const descPid = parseInt(descPidText, 10) || null;
      if (descPid) emergencyPids.push(descPid);
      const result = await probePromise;
      const settleTime = Date.now();
      const elapsed = settleTime - startTime;
      check("POSIX descendant: timeout reported (not premature ok)", result.kind === "timeout", result);
      check("POSIX descendant: does not settle before SIGKILL phase", elapsed >= timeoutMs + killGraceMs - 150, {elapsed, timeoutMs, killGraceMs});
      check("POSIX descendant: termination confirmed", result.terminationFailed === false, result);
      if (descPid) {
        let descAlive = true;
        try { process.kill(descPid, 0); } catch { descAlive = false; }
        check("POSIX descendant: SIGTERM-ignoring descendant terminated", descAlive === false, {descPid});
      } else {
        check("POSIX descendant: descendant pid recorded", false, {descPidText});
      }
      let groupAlive = true;
      try { process.kill(-leaderPid, 0); } catch (e) { groupAlive = e && e.code !== "ESRCH"; if (e && e.code === "ESRCH") groupAlive = false; }
      check("POSIX descendant: process group confirmed gone", groupAlive === false, {leaderPid});
    } finally {
      try {
        for (const pid of emergencyPids) {
          if (!pid) continue;
          try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      } catch { /* best-effort */ }
      try { fs.rmSync(tmpParent, {recursive: true, force: true}); } catch { /* best-effort */ }
    }
  }
}
{
  // Deterministic Windows boundary tests (mocked OS process boundary only).
  // Forced isWindows:true so they exercise the taskkill path on any host.
  const winDeadline = extra => ({deadline: Date.now() + 400, now: () => Date.now(), killGraceMs: 200, maxOutputBytes: 4096, backstopSlackMs: 600, isWindows: true, ...extra});
  {
    let killCalls = 0;
    const res = await runBoundedProbeTree(
      () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 0, null), 600);
        return child;
      },
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => { killCalls += 1; return {status: 0}; }})
    );
    check("windows taskkill success: timeout with confirmed cleanup", res.kind === "timeout" && res.terminationFailed === false && res.killDiagnostics?.reportedSuccess === true, res);
    check("windows taskkill success: single taskkill call", killCalls === 1, {killCalls});
  }
  {
    let killCalls = 0;
    const res = await runBoundedProbeTree(
      () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 0, null), 600);
        return child;
      },
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => { killCalls += 1; return {status: 128}; }})
    );
    check("windows nonzero taskkill: fails closed despite leader close", res.kind === "timeout" && res.terminationFailed === true && res.killDiagnostics?.status === 128 && res.killDiagnostics?.reportedSuccess === false, res);
    check("windows nonzero taskkill: single taskkill call", killCalls === 1, {killCalls});
  }
  {
    const timeoutErr = new Error("spawnSync taskkill ETIMEDOUT");
    timeoutErr.code = "ETIMEDOUT";
    const resTimeout = await runBoundedProbeTree(
      () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 0, null), 600);
        return child;
      },
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => ({status: null, error: timeoutErr})})
    );
    check("windows taskkill timeout: fails closed with timeout diagnosed", resTimeout.kind === "timeout" && resTimeout.terminationFailed === true && resTimeout.killDiagnostics?.timedOut === true, resTimeout);
    const resThrow = await runBoundedProbeTree(
      () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 0, null), 600);
        return child;
      },
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => { throw new Error("simulated taskkill failure"); }})
    );
    check("windows taskkill throw: fails closed with error surfaced", resThrow.kind === "timeout" && resThrow.terminationFailed === true && /simulated taskkill failure/.test(String(resThrow.killDiagnostics?.error || "")), resThrow);
  }
  {
    // Direct-child close racing a failed taskkill must not override the failure.
    let killCalls = 0;
    const res = await runBoundedProbeTree(
      () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 0, null), 450);
        setTimeout(() => child.emit("error", new Error("late error after close")), 500);
        setTimeout(() => child.emit("close", 1, null), 550);
        return child;
      },
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => { killCalls += 1; return {status: 1}; }})
    );
    check("windows close racing failed taskkill: stays failed", res.kind === "timeout" && res.terminationFailed === true, res);
    check("windows close race: single taskkill call", killCalls === 1, {killCalls});
    await new Promise(r => setTimeout(r, 1200));
    check("windows close race: still settled once (kill not retried)", killCalls === 1, {killCalls});
  }
  {
    // Backstop: successful taskkill but close never arrives stays unconfirmed.
    let killCalls = 0;
    const res = await runBoundedProbeTree(
      () => fakeChild(),
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => { killCalls += 1; return {status: 0}; }})
    );
    check("windows backstop without close: fails closed as unconfirmed", res.kind === "timeout" && res.terminationFailed === true, res);
    check("windows backstop: single taskkill call", killCalls === 1, {killCalls});
  }
  {
    // Single settlement across close/kill/backstop races with success.
    let killCalls = 0;
    let settlements = 0;
    const res = await runBoundedProbeTree(
      () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 0, null), 500);
        setTimeout(() => child.emit("error", new Error("late error")), 550);
        setTimeout(() => child.emit("close", 0, null), 600);
        return child;
      },
      "wsl.exe", ["--list", "--quiet"],
      winDeadline({killFn: () => { killCalls += 1; return {status: 0}; }})
    ).then(v => { settlements += 1; return v; });
    await new Promise(r => setTimeout(r, 1200));
    check("windows race: settles exactly once", settlements === 1, {settlements});
    check("windows race: success confirmed", res.terminationFailed === false && res.killDiagnostics?.reportedSuccess === true, res);
    check("windows race: single taskkill call", killCalls === 1, {killCalls});
  }
}
{
  // Strengthened malformed WSL list coverage.
  const oddBomTruncated = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("Ubuntu", "utf16le"), Buffer.from([0x41])]);
  const oddParsed = decodeWslDistroListBytes(oddBomTruncated);
  check("malformed UTF-16LE odd trailing byte rejected", oddParsed.malformed === true && /odd_trailing_byte/i.test(oddParsed.detail || ""), oddParsed);
  const oddNoBom = Buffer.concat([Buffer.from("Ubuntu", "utf16le"), Buffer.from([0x00])]);
  // "Ubuntu" in utf16le is 12 bytes (even); +1 zero byte => 13 bytes odd with nulls => malformed odd trailing byte.
  const oddNoBomParsed = decodeWslDistroListBytes(oddNoBom);
  check("malformed UTF-16LE odd trailing byte without BOM rejected", oddNoBomParsed.malformed === true && /odd_trailing_byte/i.test(oddNoBomParsed.detail || ""), oddNoBomParsed);
  const invalidUtf8 = decodeWslDistroListBytes(Buffer.from([0xC3, 0x28]));
  check("invalid UTF-8 rejected strictly", invalidUtf8.malformed === true && /invalid_utf8/i.test(invalidUtf8.detail || ""), invalidUtf8);
  const bomLoneHigh = decodeWslDistroListBytes(Buffer.from([0xFF, 0xFE, 0x00, 0xD8]));
  check("BOM lone high surrogate rejected", bomLoneHigh.malformed === true && /invalid_utf16/i.test(bomLoneHigh.detail || ""), bomLoneHigh);
  const bomLoneLow = decodeWslDistroListBytes(Buffer.from([0xFF, 0xFE, 0x00, 0xDC]));
  check("BOM lone low surrogate rejected", bomLoneLow.malformed === true && /invalid_utf16/i.test(bomLoneLow.detail || ""), bomLoneLow);
  const bomlessLoneHigh = decodeWslDistroListBytes(Buffer.from([0x00, 0xD8]));
  check("BOM-less lone high surrogate rejected", bomlessLoneHigh.malformed === true && /invalid_utf16/i.test(bomlessLoneHigh.detail || ""), bomlessLoneHigh);
  const bomlessLoneLow = decodeWslDistroListBytes(Buffer.from([0x00, 0xDC]));
  check("BOM-less lone low surrogate rejected", bomlessLoneLow.malformed === true && /invalid_utf16/i.test(bomlessLoneLow.detail || ""), bomlessLoneLow);
  const truncatedPair = decodeWslDistroListBytes(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from([0x3D, 0xD8])]));
  check("truncated surrogate pair rejected", truncatedPair.malformed === true, truncatedPair);
  const validNonBmp = decodeWslDistroListBytes(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("A😀 B\r\n", "utf16le")]));
  check("valid surrogate pair non-BMP Unicode preserved", validNonBmp.malformed === false && validNonBmp.distros[0] === "A😀 B", validNonBmp);
  const validSpaceName = decodeWslDistroListBytes(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("My Distro\r\n", "utf16le")]));
  check("valid ordinary UTF-16LE name with spaces preserved", validSpaceName.malformed === false && validSpaceName.distros[0] === "My Distro", validSpaceName);
  const ffBytes = decodeWslDistroListBytes(Buffer.from([0xFF, 0xFF, 0xFF]));
  check("lone 0xFF bytes rejected as invalid UTF-8", ffBytes.malformed === true, ffBytes);
  const validUtf8StillOk = decodeWslDistroListBytes(utf8ListBytes(["Ubuntu"]));
  check("valid UTF-8 still accepted", validUtf8StillOk.malformed === false && validUtf8StillOk.distros[0] === "Ubuntu", validUtf8StillOk);
  const validUtf16StillOk = decodeWslDistroListBytes(utf16leListBytes(["Ubuntu"], true));
  check("valid UTF-16LE still accepted", validUtf16StillOk.malformed === false && validUtf16StillOk.distros[0] === "Ubuntu", validUtf16StillOk);
  const badUtf8 = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: (bin, args) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (args[0] === "--list") {
          child.stdout.emit("data", Buffer.from([0xFF, 0xFF, 0xFF]));
          child.emit("close", 0, null);
        } else {
          child.emit("close", 1, null);
        }
      });
      return child;
    },
    timeoutMs: 5000
  });
  check("malformed list output: unavailable with malformed reason", /malformed/i.test(modeById(badUtf8, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), badUtf8);
  const oddViaDiscovery = await detectRuntimeModeCapabilities({
    platformKind: PLATFORM_KINDS.nativeWindows,
    spawn: makeWslMock({listBytes: oddBomTruncated}),
    timeoutMs: 5000
  });
  check("odd trailing byte via discovery: malformed", /malformed/i.test(modeById(oddViaDiscovery, RUNTIME_MODE_IDS.wsl2Strong).reason || ""), oddViaDiscovery);
  {
    const calls = [];
    const loneHighBytes = Buffer.from([0xFF, 0xFE, 0x00, 0xD8]);
    const res = await detectRuntimeModeCapabilities({
      platformKind: PLATFORM_KINDS.nativeWindows,
      spawn: makeWslMock({listBytes: loneHighBytes, calls}),
      timeoutMs: 5000
    });
    const strong = modeById(res, RUNTIME_MODE_IDS.wsl2Strong);
    check("malformed surrogate via discovery: unavailable", strong.available === false && strong.distro === null && /malformed/i.test(strong.reason || ""), strong);
    check("malformed surrogate via discovery: no per-distro probes", calls.length === 1 && calls[0].args[0] === "--list", calls);
  }
}

// ---------------------------------------------------------------------
// Truthful recommendedMode + supportedFrameworks across all modes
// ---------------------------------------------------------------------
{
  const cases = [
    {platformKind: PLATFORM_KINDS.wsl2, spawn: makeBubblewrapMock({version: "ok", sandbox: "ok"})},
    {platformKind: PLATFORM_KINDS.nativeLinux, spawn: makeBubblewrapMock({version: "ok", sandbox: "ok"})},
    {platformKind: PLATFORM_KINDS.nativeWindows, spawn: makeWslMock({listBytes: utf8ListBytes(["Ubuntu"])})}
  ];
  for (const {platformKind, spawn} of cases) {
    const result = await detectRuntimeModeCapabilities({platformKind, spawn, timeoutMs: 8000});
    const recommended = result.modes.find(m => m.id === result.recommendedMode);
    check(`truthful recommendedMode for ${platformKind}: points at available mode or null`, result.recommendedMode === null ? result.modes.every(m => !m.available) : recommended?.available === true, result);
    for (const mode of result.modes) {
      if (mode.id === RUNTIME_MODE_IDS.windowsCompatibility) {
        check(`truthful frameworks ${platformKind}/${mode.id}: speckit-and-standalone`, JSON.stringify(mode.supportedFrameworks) === JSON.stringify(["speckit", "standalone"]), mode);
        check(`strength ${platformKind}/${mode.id} is compatibility`, mode.strength === "compatibility", mode);
      } else {
        check(`truthful frameworks ${platformKind}/${mode.id}: all`, JSON.stringify(mode.supportedFrameworks.slice().sort()) === JSON.stringify([...SUPPORTED_FRAMEWORKS_ALL].slice().sort()), mode);
        check(`strength ${platformKind}/${mode.id} is strong`, mode.strength === "strong", mode);
      }
      check(`mode shape ${platformKind}/${mode.id}`, assertModeShape(mode), mode);
    }
  }
}

// ---------------------------------------------------------------------
// Real read-only discovery probe (no distro-name dependence)
// ---------------------------------------------------------------------
{
  const real = await detectRuntimeModeCapabilities({timeoutMs: 15000});
  check("real discovery: returns currentPlatform", typeof real.currentPlatform === "string" && Object.values(PLATFORM_KINDS).includes(real.currentPlatform), real);
  check("real discovery: three structured modes", Array.isArray(real.modes) && real.modes.length === 3 && real.modes.every(assertModeShape), real);
  check("real discovery: recommendedMode truthful (available or null)", real.recommendedMode === null ? real.modes.every(m => !m.available) : modeById(real, real.recommendedMode)?.available === true, real);
  check("real discovery: strengths truthful", modeById(real, RUNTIME_MODE_IDS.windowsCompatibility).strength === "compatibility" && modeById(real, RUNTIME_MODE_IDS.wsl2Strong).strength === "strong", real);
  check("real discovery: compat frameworks speckit-and-standalone", JSON.stringify(modeById(real, RUNTIME_MODE_IDS.windowsCompatibility).supportedFrameworks) === JSON.stringify(["speckit", "standalone"]), real);
  const wslStrong = modeById(real, RUNTIME_MODE_IDS.wsl2Strong);
  // distro is applicable only for Native Windows discovery (selected usable
  // distro). Inside WSL2 / Native Linux the current process is already the
  // strong runtime, so distro is null by design — no name dependence either way.
  if (real.currentPlatform === PLATFORM_KINDS.nativeWindows) {
    check("real discovery: distro present iff wsl2-strong available (no name dependence)", wslStrong.available ? (typeof wslStrong.distro === "string" && wslStrong.distro.length > 0) : wslStrong.distro === null, wslStrong);
  } else {
    check("real discovery: distro null outside Windows (current-process runtime)", wslStrong.distro === null, wslStrong);
  }
  if (real.currentPlatform === PLATFORM_KINDS.nativeWindows) {
    const compat = modeById(real, RUNTIME_MODE_IDS.windowsCompatibility);
    check("real windows: compat available and not OS-enforced", compat.available === true && /not OS-enforced/.test(compat.reason || ""), compat);
  }
}

// Module surface stays discovery-only.
{
  const mod = await import("./runtime-mode-capabilities.mjs");
  check("module surface is discovery-only (no setup/config/run exports)", !("saveConfig" in mod) && !("selectRuntime" in mod) && !("runMission" in mod), Object.keys(mod));
}

if (failures > 0) {
  console.error(`\n${failures} runtime-mode-capabilities check(s) failed.`);
  process.exit(1);
}
console.log("\nAll runtime-mode-capabilities checks passed.");
