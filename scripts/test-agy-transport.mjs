#!/usr/bin/env node
// Task 1.4: the agy transport end-to-end, entirely offline. A PATH-stub
// `agy` — a node script prepended to PATH so it shadows any installed agy —
// emits the scripted stream-json fixtures scripts/test-agy-events.mjs and
// scripts/test-agy-wire.mjs replay and records the exact stdin bytes it was
// handed. The real resolver in scripts/adapter-transport.mjs resolves the
// mission and `models` invocations against the stub, and the stub proves the
// mission prompt reaches agy framed as one stream-json user event. No real
// agy is spawned: the stub is the only `agy` PATH can reach.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {adapterDriver, accumulateUsage, AGY_SETTINGS_RELATIVE_PATH} from "./adapter-drivers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-transport-"));
const stubDir = path.join(root, "bin");
fs.mkdirSync(stubDir, {recursive: true});
const stubPath = path.join(stubDir, "agy");
const stdinCapture = path.join(root, "received-stdin.txt");

const CID = "9ec58bfd-4e9c-4f5e-83a5-9d907e9c6b1f";
// Scripted stream-json fixtures — the same event shapes the task-1.2/1.3
// fixtures replay: init, a user_input step, one agent_response turn carrying
// usage, a successful tool step, and the cumulative terminal result.
const FIXTURES = [
  {event: "init", conversation_id: CID, init: {cwd: "/repo", tools: ["run_command", "write_to_file", "view_file"], permission_mode: "request-review"}},
  {event: "step_update", step_update: {conversation_id: CID, step_index: 0, state: "DONE", step_type: "user_input"}},
  {event: "step_update", step_update: {conversation_id: CID, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "done\n", duration_seconds: 1.1, usage: {input_tokens: 1000, output_tokens: 50, thinking_tokens: 10, cache_read_tokens: 200, total_tokens: 1260}}},
  {event: "step_update", step_update: {conversation_id: CID, step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: {name: "run_command", parameters: {CommandLine: "ls -la"}, output: "ok"}}},
  {event: "result", result: {conversation_id: CID, status: "SUCCESS", response: "ok\n", duration_seconds: 3, num_turns: 1, usage: {input_tokens: 1500, output_tokens: 70, thinking_tokens: 10, cache_read_tokens: 300, total_tokens: 1880}}}
].map(event => JSON.stringify(event)).join("\n") + "\n";

// The stub: records every stdin byte it receives (the framing proof), emits
// the scripted fixtures on stdout (so the real driver decodes a real child's
// output), and exits 0. A short unref'd timer keeps a pathological
// never-closing stdin from hanging the harness.
fs.writeFileSync(stubPath, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("error", () => {});
const finish = () => {
  fs.writeFileSync(${JSON.stringify(stdinCapture)}, input);
  process.stdout.write(${JSON.stringify(FIXTURES)});
  process.exit(0);
};
process.stdin.on("end", finish);
setTimeout(finish, 5000).unref();
`);
try { fs.chmodSync(stubPath, 0o755); } catch {}

const previousPath = process.env.PATH;
process.env.PATH = `${stubDir}${path.delimiter}${previousPath}`;
// The resolver preserves the driver's invocation record verbatim, so the
// binary it hands back is the manifest name the request named — every spawn
// path re-resolves that name through PATH (where the stub shadows any
// installed agy) exactly as spawnAgentSync would.
const resolvedStub = fs.realpathSync(stubPath);
const driver = adapterDriver("antigravity");
assert.ok(driver, 'adapterDriver("antigravity") must resolve to a driver');

try {
  // ── 1. The PATH stub is the agy the resolver sees — offline by construction ──
  const which = spawnSync("which", ["agy"], {encoding: "utf8", env: process.env});
  assert.equal(which.status, 0, `the stub agy must be reachable on PATH, got: ${which.stderr}`);
  assert.equal(String(which.stdout).trim(), stubPath, "the stub agy must shadow any installed agy");

  // ── 2. The antigravity mission transport resolves available ───────────────
  const scratchDir = path.join(root, "run-1");
  fs.mkdirSync(scratchDir, {recursive: true});
  const PROMPT = "TASK: prove the agy transport\n\nSecond line <with> markup.";
  const framed = driver.encodeStdin(PROMPT);
  assert.ok(framed.endsWith("\n"), "the framed prompt must be one newline-terminated NDJSON line");
  const mission = resolveAdapterTransport({
    driver,
    profile: null,
    request: {binary: "agy", mode: "write", model: "m", reasoning: "high", scratchDir, stdin: framed}
  });
  assert.equal(mission.available, true, `the antigravity transport must resolve available, got: ${mission.reason}`);
  assert.equal(mission.reason, null, "an available transport carries no reason");
  assert.equal(mission.failure, null, "an available transport carries no failure");
  assert.equal(mission.invocation.binary, "agy", `the resolver must preserve the agy invocation record verbatim, got: ${mission.invocation.binary}`);
  assert.equal(mission.stdin, framed, "the resolver must preserve the framed stdin verbatim");
  const args = mission.invocation.args;
  const has = (flag, value) => args.includes(flag) && args[args.indexOf(flag) + 1] === value;
  assert.ok(has("--input-format", "stream-json"), `mission argv must carry --input-format stream-json, got: ${args.join(" ")}`);
  assert.ok(has("--output-format", "stream-json"), `mission argv must carry --output-format stream-json, got: ${args.join(" ")}`);
  assert.ok(!args.includes("--print") && !args.includes("--prompt"), "no prompt may ride on argv in stream-json mode");
  assert.equal(
    mission.invocation.settingsPath,
    path.join(scratchDir, AGY_SETTINGS_RELATIVE_PATH),
    "a write run must carry the per-run settings file inside its own scratch dir"
  );

  // ── 3. The agy models invocation now resolves available ──────────────────
  // Mirrors scripts/model-discovery.mjs:262 exactly (bare binary name plus
  // the `models` argv), which the denial removal is what unblocked.
  const models = resolveAdapterTransport({driver, request: {binary: "agy", args: ["models"]}});
  assert.equal(models.available, true, `the agy models invocation must resolve available, got: ${models.reason}`);
  assert.equal(models.failure, null, "an available models invocation carries no failure");
  assert.deepEqual(models.invocation.args, ["models"], "the models command must pass through untouched");
  // The passthrough branch hands back exactly the target spawnAgentSync would
  // pick: the PATH lookup of `agy` (the stub here), symlinks resolved.
  assert.equal(fs.realpathSync(models.invocation.binary), resolvedStub, "the models invocation must resolve to the PATH-resolved agy binary (the stub)");
  const modelsRun = spawnSync(resolvedStub, models.invocation.args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env
  });
  assert.equal(modelsRun.status, 0, `the stub agy must serve the models invocation offline, got: ${modelsRun.status}`);
  assert.ok(modelsRun.stdout.includes('"event":"init"'), "the stub must emit the scripted fixtures");
  assert.equal(fs.readFileSync(stdinCapture, "utf8"), "", "the models command sends no stdin");

  // ── 4. stdin reaches agy framed as stream-json ───────────────────────────
  const missionRun = spawnSync(resolvedStub, mission.invocation.args, {
    input: mission.stdin, encoding: "utf8", env: process.env
  });
  assert.equal(missionRun.status, 0, `the stub agy must exit 0 for a mission run, got: ${missionRun.status} stderr=${missionRun.stderr}`);
  const received = fs.readFileSync(stdinCapture, "utf8");
  assert.equal(received, framed, "the child must receive exactly the framed stream-json line, byte for byte");
  assert.deepEqual(
    JSON.parse(received.trim()),
    {event: "user", message: {content: PROMPT}},
    "stdin must arrive as one {event:user,message:{content}} NDJSON line"
  );
  // The child's emitted stream decodes, observes, and accumulates through the
  // real driver dispatch — the transport is proven end to end, not just resolved.
  const events = driver.decodeEvents(missionRun.stdout, "");
  assert.ok(events.some(event => event.event === "init"), "the stub's init fixture must decode");
  const observations = driver.observe(events, {readPath: "", productionWritePath: "", outsideWritePath: ""});
  assert.ok(
    observations.some(o => o.type === "command_attempted"),
    `the successful run_command fixture must be observed, got: ${observations.map(o => o.type).join(",")}`
  );
  const usage = accumulateUsage("antigravity", events);
  assert.ok(usage && usage.input === 1500, `the cumulative terminal usage must accumulate, got: ${JSON.stringify(usage)}`);

  // ── 5. All three stale denial spots now expect available ─────────────────
  const read = name => fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  const authoritySource = read("test-transport-authority.mjs");
  assert.ok(authoritySource.includes("antigravity resolves available"), "test-transport-authority.mjs must expect antigravity available");
  assert.ok(!authoritySource.includes("agy_stdin_transport_unproven") && !authoritySource.includes("transport-denied"),
    "test-transport-authority.mjs must no longer assert the removed agy denial");
  const transportSource = read("test-adapter-transport.mjs");
  assert.ok(transportSource.includes("antigravity resolves available"), "test-adapter-transport.mjs must expect antigravity available");
  assert.ok(!transportSource.includes("agy_stdin_transport_unproven") && !transportSource.includes("Transport-unproven"),
    "test-adapter-transport.mjs must no longer assert the removed agy denial");
  const preflightSource = read("test-preflight-deduplication.mjs");
  assert.ok(preflightSource.includes("resolves available"), "test-preflight-deduplication.mjs must describe antigravity as available");
  assert.ok(!preflightSource.includes("unproven by design"), "test-preflight-deduplication.mjs must no longer call the transport unproven");
  const self = path.basename(new URL(import.meta.url).pathname);
  for (const entry of fs.readdirSync(path.dirname(new URL(import.meta.url).pathname))) {
    if (!entry.endsWith(".mjs") || entry === self) continue;
    assert.ok(
      !read(entry).includes("agy_stdin_transport_unproven"),
      `${entry} must not reference the removed agy_stdin_transport_unproven denial`
    );
  }
} finally {
  if (previousPath == null) delete process.env.PATH; else process.env.PATH = previousPath;
  fs.rmSync(root, {recursive: true, force: true});
}

console.log("test-agy-transport: ALL CHECKS PASSED");
