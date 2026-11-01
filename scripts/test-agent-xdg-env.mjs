#!/usr/bin/env node
// Backlog #14 follow-up: XDG base-directory authority for OpenCode 2.
//
// A native (unenveloped) role launch must observe the operator's XDG roots:
// an OpenCode 2 install under XDG_DATA_HOME=~/.opencode2/xdg/data keeps its
// credential DB there, and stripping XDG_* makes a native v2 process look in
// ~/.local/share/opencode and fail with PROVIDER_ERROR provider.no-route.
//
// An enveloped launch must NOT receive any host XDG_* path: the sandbox has a
// fresh HOME and a read-only host view, so a host XDG location would make v2
// write there (EROFS) or read an unmounted credential store. The droppped
// variables let it fall back to SANDBOX_HOME, where the #14 credential import
// mounts its data dir (.local/share/opencode).
//
// The gate/test-command environment (createGateShell -> guardedCommandEnv)
// stays byte-for-byte unchanged: XDG_* is scoped to agent launches only.
//
// Every opencode invocation below is a fake script in a test-owned directory;
// the real CLI is never invoked and no real credential file is read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
  assembleAgentEnvironment,
  NATIVE_AGENT_LOCATION_ENV_NAMES,
  nativeAgentLocationEnvironment
} from "./agent-environment.mjs";
import {mapEnvironmentIntoEnvelope, SANDBOX_HOME} from "./execution-envelope.mjs";
import {createGateShell} from "./gate-shell.mjs";
import {guardedCommandEnv} from "./relay-guards.mjs";
import {openCodeAuthListProviders, prepareOpenCodeSandboxCredentials} from "./opencode-credentials.mjs";
import {discoverModelCatalog} from "./model-discovery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const agents = JSON.parse(fs.readFileSync(path.join(root, "adapters", "agents.json"), "utf8")).adapters;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-agent-xdg-"));
const cleanup = () => {
  try { fs.rmSync(temporaryRoot, {recursive: true, force: true}); } catch { /* best-effort */ }
};
process.on("exit", cleanup);

const XDG_NAMES = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"];
const savedXdg = Object.fromEntries(XDG_NAMES.map((name) => [name, process.env[name]]));
function setHostXdg(prefix) {
  for (const name of XDG_NAMES) process.env[name] = path.join(temporaryRoot, prefix, name.toLowerCase());
}
function restoreXdg() {
  for (const name of XDG_NAMES) {
    if (savedXdg[name] === undefined) delete process.env[name];
    else process.env[name] = savedXdg[name];
  }
}

// ── 1. Native agent env keeps XDG_* from process.env ─────────────────────
{
  setHostXdg("host-native");
  try {
    const native = assembleAgentEnvironment({
      guardedEnv: {PATH: "/usr/bin:/bin", HOME: "/operator/home"},
      envelope: null,
      adapterRoleScratchExists: false,
      gatewayActive: false
    });
    check("native: all four XDG locations are preserved from process.env",
      XDG_NAMES.every((name) => native.spawnEnv[name] === process.env[name]), native.spawnEnv);
    check("native: XDG values are the operator's configured locations",
      native.spawnEnv.XDG_DATA_HOME === path.join(temporaryRoot, "host-native", "xdg_data_home")
      && native.spawnEnv.XDG_CONFIG_HOME === path.join(temporaryRoot, "host-native", "xdg_config_home"), native.spawnEnv);

    // The helper is pure and returns only the set location names.
    const projected = nativeAgentLocationEnvironment({XDG_DATA_HOME: "/xdg/data", PATH: "/bin", HOME: "/h"});
    check("native: location projection keeps only set XDG_* names",
      JSON.stringify(projected) === JSON.stringify({XDG_DATA_HOME: "/xdg/data"}), projected);
    check("native: NATIVE_AGENT_LOCATION_ENV_NAMES is exactly the four locations",
      NATIVE_AGENT_LOCATION_ENV_NAMES.length === 4
      && NATIVE_AGENT_LOCATION_ENV_NAMES.every((name) => XDG_NAMES.includes(name)),
      NATIVE_AGENT_LOCATION_ENV_NAMES);
  } finally {
    restoreXdg();
  }
}

// ── 2. An explicitly supplied host env is honored (never ambient leakage) ─
{
  const hostEnv = {
    XDG_DATA_HOME: path.join(temporaryRoot, "explicit", "data"),
    XDG_STATE_HOME: path.join(temporaryRoot, "explicit", "state"),
    XDG_CACHE_HOME: path.join(temporaryRoot, "explicit", "cache"),
    XDG_CONFIG_HOME: path.join(temporaryRoot, "explicit", "config")
  };
  const native = assembleAgentEnvironment({
    guardedEnv: {PATH: "/usr/bin:/bin", HOME: "/operator/home"},
    envelope: null,
    hostEnv
  });
  check("native explicit hostEnv: all four XDG locations are preserved",
    XDG_NAMES.every((name) => native.spawnEnv[name] === hostEnv[name]), native.spawnEnv);
}

// ── 3. Enveloped launch drops every host XDG_* path ──────────────────────
{
  setHostXdg("host-enveloped");
  try {
    const mockEnvelope = {
      available: true,
      sandbox: {repository: "/workspace/repository", scratch: "/workspace/scratch"},
      args: []
    };
    const hostXdgValues = XDG_NAMES.map((name) => process.env[name]);
    // Simulate a caller that somehow seeded XDG values into guardedEnv too:
    // the enveloped mapping must still drop them.
    const guarded = {
      PATH: "/usr/bin:/bin",
      HOME: "/operator/home",
      ...Object.fromEntries(XDG_NAMES.map((name) => [name, process.env[name]]))
    };
    const mapped = mapEnvironmentIntoEnvelope(guarded, mockEnvelope, "/host/repo", null);
    check("enveloped map: no XDG_* key survives",
      !Object.keys(mapped).some((name) => name.toUpperCase().startsWith("XDG_")), mapped);
    check("enveloped map: no host XDG value survives in any value",
      !Object.values(mapped).some((value) => hostXdgValues.some((hostValue) => String(value).includes(hostValue))), mapped);
    check("enveloped map: HOME is the sandbox HOME (XDG defaults resolve there)",
      mapped.HOME === SANDBOX_HOME, mapped.HOME);

    const assembled = assembleAgentEnvironment({
      guardedEnv: guarded,
      envelope: mockEnvelope,
      repo: "/host/repo",
      scratchDir: null,
      hostEnv: process.env
    });
    check("enveloped assembler: spawnEnv has no XDG_* key",
      !Object.keys(assembled.spawnEnv).some((name) => name.toUpperCase().startsWith("XDG_")), assembled.spawnEnv);
    check("enveloped assembler: spawnEnv has no host XDG path value",
      !Object.values(assembled.spawnEnv).some((value) => hostXdgValues.some((hostValue) => String(value).includes(hostValue))), assembled.spawnEnv);
    check("enveloped assembler: HOME is the sandbox HOME",
      assembled.spawnEnv.HOME === SANDBOX_HOME, assembled.spawnEnv.HOME);
  } finally {
    restoreXdg();
  }
}

// ── 4. Gate/test-command env is unchanged (XDG scoped to agents only) ────
{
  setHostXdg("host-gate");
  const gateRoot = fs.mkdtempSync(path.join(temporaryRoot, "gate-"));
  try {
    const gate = createGateShell(gateRoot, gateRoot, false);
    check("gate env: no XDG_* key is introduced from the host",
      !Object.keys(gate.env).some((name) => name.toUpperCase().startsWith("XDG_")), Object.keys(gate.env).sort());
    // guardedCommandEnv is the same production value the gate uses; this is
    // the regression guard against ever adding these names to SAFE_ENV_NAMES.
    const commandEnv = guardedCommandEnv(gate.guard, {});
    check("gate env: guardedCommandEnv does not admit XDG_*",
      XDG_NAMES.every((name) => !(name in commandEnv)), Object.keys(commandEnv).sort());
  } finally {
    restoreXdg();
  }
}

// ── 5. Host-side auth export/list/discovery see the operator's XDG env ───
function makeFakeOpenCode() {
  const binDir = fs.mkdtempSync(path.join(temporaryRoot, "fake-bin-"));
  const log = path.join(binDir, "fake.log");
  const script = path.join(binDir, "fake-opencode.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";
const LOG = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const xdg = process.env.XDG_DATA_HOME || "";
const log = (line) => fs.appendFileSync(LOG, line + "\\n");
if (args[0] === "--version") { process.stdout.write("opencode 2.0.0\\n"); process.exit(0); }
if (args[0] === "run" && args[1] === "--help") {
  process.stdout.write("Usage: opencode run [message..]\\n  -m, --model <provider/model#variant>  model to use\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "list") {
  log("AUTH_LIST_XDG=" + xdg);
  process.stdout.write("deepseek  DeepSeek  stored\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "export") {
  log("EXPORT_ARGS=" + args.join(" "));
  log("EXPORT_XDG=" + xdg);
  process.stdout.write(JSON.stringify([{id: "deepseek", integrationID: "deepseek", label: "DeepSeek", active: true, value: {type: "api", key: "FAKE"}}]));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "import") {
  try { fs.readFileSync(0, "utf8"); } catch {}
  log("IMPORT_ARGS=" + args.join(" "));
  log("IMPORT_XDG=" + xdg);
  process.exit(0);
} else if (args[0] === "api" && args[1] === "GET" && args[2] === "/api/model") {
  log("MODEL_API_XDG=" + xdg);
  process.stdout.write(JSON.stringify({data: [{providerID: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", enabled: true, status: "active", variants: [{id: "low"}]}]}));
  process.exit(0);
} else if (args[0] === "models") {
  process.stdout.write("deepseek/deepseek-flash\\n");
  process.exit(0);
}
process.exit(1);
`);
  let binary;
  if (process.platform === "win32") {
    binary = path.join(binDir, "opencode.cmd");
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    binary = path.join(binDir, "opencode");
    fs.writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    fs.chmodSync(binary, 0o755);
  }
  return {binary, log, adapter: {...agents.opencode, binary}};
}

function readLog(log) {
  try { return fs.readFileSync(log, "utf8"); } catch { return ""; }
}

if (process.platform !== "win32") {
  setHostXdg("host-auth");
  const fake = makeFakeOpenCode();
  try {
    const listed = openCodeAuthListProviders({binary: fake.binary});
    check("auth list: provider is listed", listed.ok === true && listed.providers.includes("deepseek"), listed);
    check("auth list: child inherits the operator's XDG_DATA_HOME",
      readLog(fake.log).includes(`AUTH_LIST_XDG=${process.env.XDG_DATA_HOME}`), readLog(fake.log));

    const catalog = await discoverModelCatalog(fake.adapter, {timeoutMs: 10_000});
    check("model discovery: OpenCode 2 catalog is reported",
      catalog.status === "reported" && catalog.some((entry) => entry.id === "deepseek/deepseek-flash"), catalog);
    check("model discovery: child inherits the operator's XDG_DATA_HOME",
      readLog(fake.log).includes(`MODEL_API_XDG=${process.env.XDG_DATA_HOME}`), readLog(fake.log));

    const prepared = await prepareOpenCodeSandboxCredentials({
      adapter: fake.adapter,
      adapterId: "opencode",
      model: "deepseek/deepseek-flash#low",
      sandboxDataPath: `${SANDBOX_HOME}/.local/share/opencode`
    });
    const lines = readLog(fake.log).split(/\r?\n/);
    check("credential export: host child inherits the operator's XDG_DATA_HOME",
      lines.includes(`EXPORT_XDG=${process.env.XDG_DATA_HOME}`), lines);
    check("credential import: child uses the private XDG root instead",
      prepared && lines.includes(`IMPORT_XDG=${prepared.xdgRoot}`), lines);
    check("credential import: argv is standalone (not the shared background service)",
      lines.includes("IMPORT_ARGS=auth import --standalone"), lines);
    prepared?.cleanup();
  } finally {
    restoreXdg();
  }
}

if (failures) {
  console.error(`${failures} agent XDG environment check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
