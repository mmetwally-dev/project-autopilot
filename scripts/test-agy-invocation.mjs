#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {adapterDriver, AGY_SETTINGS_RELATIVE_PATH, encodeAgyStdin} from "./adapter-drivers.mjs";
import {buildRelayArgsForTests} from "./autopilot.mjs";
import {resolveAdapterTransport} from "./adapter-transport.mjs";

// ── 1. Settings-path constant (verified against installed agy + official docs) ──
// Official docs (antigravity.google/docs/settings?tab=cli, "Configuration file
// location"): persistent CLI settings live at ~/.gemini/antigravity-cli/settings.json.
assert.equal(
  AGY_SETTINGS_RELATIVE_PATH,
  ".gemini/antigravity-cli/settings.json",
  `AGY_SETTINGS_RELATIVE_PATH must be the documented agy settings path, got: ${AGY_SETTINGS_RELATIVE_PATH}`
);

const driver = adapterDriver("antigravity");
assert.ok(driver, 'adapterDriver("antigravity") must resolve to a driver');

// ── 2. No transportPrompt: every driver uses stdin ───────────────────────────
assert.equal(
  driver.transportPrompt,
  undefined,
  "agy driver must not declare transportPrompt (stdin-only transport)"
);

// ── 3. Stdin stream-json argv contract, all modes ────────────────────────────
for (const mode of ["write", "scratch", "read_only"]) {
  const invocation = driver.buildInvocation({binary: "agy", mode, model: "m", reasoning: "high", scratchDir: "/tmp/scratch-x"});
  const args = invocation.args;
  assert.equal(invocation.binary, "agy", `binary must pass through (mode=${mode})`);
  const has = (flag, value) => args.includes(flag) && args[args.indexOf(flag) + 1] === value;
  assert.ok(has("--input-format", "stream-json"), `${mode}: argv must carry --input-format stream-json, got: ${args.join(" ")}`);
  assert.ok(has("--output-format", "stream-json"), `${mode}: argv must carry --output-format stream-json, got: ${args.join(" ")}`);
  assert.ok(args.includes("-p") && args[args.indexOf("-p") + 1] === "", `${mode}: argv must carry -p "" (empty noninteractive prompt slot), got: ${args.join(" ")}`);
  assert.ok(has("--conversation", "resume"), `${mode}: argv must carry --conversation resume, got: ${args.join(" ")}`);
  assert.ok(!args.includes("--print"), `${mode}: argv must NOT contain --print, got: ${args.join(" ")}`);
  assert.ok(!args.includes("--prompt"), `${mode}: argv must NOT contain --prompt, got: ${args.join(" ")}`);
  assert.ok(
    args.includes("--mode") && ["accept-edits", "plan"].includes(args[args.indexOf("--mode") + 1]),
    `${mode}: argv must carry --mode accept-edits|plan, got: ${args.join(" ")}`
  );
}

// ── 4. Encoder frames raw relay text as a stream-json user event ─────────────
assert.equal(typeof driver.encodeStdin, "function", "agy driver must expose encodeStdin");
assert.equal(typeof encodeAgyStdin, "function", "adapter-drivers.mjs must export encodeAgyStdin");
assert.equal(driver.encodeStdin, encodeAgyStdin, "driver.encodeStdin must be the exported encodeAgyStdin");
const raw = "hello relay <text> with \"quotes\"";
const line = driver.encodeStdin(raw);
assert.ok(line.endsWith("\n"), "encoded stdin must be one newline-terminated NDJSON line");
const parsed = JSON.parse(line);
assert.deepEqual(parsed, {event: "user", message: {content: raw}}, "encoder must frame raw text as {event:user,message:{content}}");

// ── 5. read_only passes no command permission ────────────────────────────────
const readOnly = driver.buildInvocation({binary: "agy", mode: "read_only", model: "m", reasoning: "low"});
assert.ok(
  !readOnly.args.join("\n").includes("command("),
  `read_only argv must pass no command(...) permission rule, got: ${readOnly.args.join(" ")}`
);
assert.ok(
  !readOnly.args.includes("--dangerously-skip-permissions"),
  `read_only argv must NOT auto-approve permissions, got: ${readOnly.args.join(" ")}`
);

// ── 6. Production argv: the manifest args are the stream-json contract ───────
// runRelay resolves the mission transport WITHOUT a mode
// (scripts/autopilot.mjs `resolveAdapterTransport({driver, profile:null,
// request:{binary,args,stdin}})`), so adapter-transport.mjs falls back to the
// manifest argv `buildRelayArgs` assembled — the driver's own buildInvocation
// never runs there. The manifest write/read_only args therefore have to carry
// the same stdin contract, or the real agy child gets a stream-json stdin line
// without the flags that make it one. Build the args with the real builder and
// push them through the real resolver in the production call shape.
const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-invocation-"));
const stubDir = path.join(stubRoot, "bin");
fs.mkdirSync(stubDir, {recursive: true});
fs.writeFileSync(path.join(stubDir, "agy"), "#!/usr/bin/env node\nprocess.exit(0);\n");
try { fs.chmodSync(path.join(stubDir, "agy"), 0o755); } catch {}
process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;

const manifest = JSON.parse(fs.readFileSync(new URL("../adapters/agents.json", import.meta.url), "utf8"));
const manifestAdapter = manifest.adapters.antigravity;
assert.ok(manifestAdapter, "adapters/agents.json must declare antigravity");
assert.equal(manifestAdapter.binary, "agy", "the antigravity manifest binary must be agy");

const PROMPT = "TASK: implement 092\n\nSecond line <with> markup.";
const countFlag = (list, flag) => list.filter(item => item === flag).length;

for (const readOnly of [false, true]) {
  const label = readOnly ? "read_only" : "write";
  const role = {name: "implementer", adapter: "antigravity", model: null, reasoning: null, resume: false};
  const stdinSink = {text: null};
  const relayArgs = buildRelayArgsForTests(role, manifestAdapter, readOnly, false, null, {promptText: PROMPT, stdinSink});
  const transport = resolveAdapterTransport({
    driver,
    profile: null,
    request: {binary: manifestAdapter.binary, args: relayArgs, stdin: stdinSink.text == null ? PROMPT : stdinSink.text}
  });
  assert.equal(
    transport.available,
    true,
    `${label}: the production relay transport must resolve available, got: ${transport.reason}`
  );
  const manifestArgs = transport.invocation.args;
  const has = (flag, value) => manifestArgs.includes(flag) && manifestArgs[manifestArgs.indexOf(flag) + 1] === value;
  assert.ok(has("--input-format", "stream-json"), `${label}: manifest argv must carry --input-format stream-json, got: ${manifestArgs.join(" ")}`);
  assert.ok(has("--output-format", "stream-json"), `${label}: manifest argv must carry --output-format stream-json, got: ${manifestArgs.join(" ")}`);
  assert.ok(manifestArgs.includes("-p") && manifestArgs[manifestArgs.indexOf("-p") + 1] === "", `${label}: manifest argv must carry -p "", got: ${manifestArgs.join(" ")}`);
  assert.ok(has("--mode", readOnly ? "plan" : "accept-edits"), `${label}: manifest argv must carry --mode, got: ${manifestArgs.join(" ")}`);
  assert.ok(!manifestArgs.includes("--print"), `${label}: manifest argv must NOT contain --print, got: ${manifestArgs.join(" ")}`);
  assert.ok(!manifestArgs.includes("--prompt"), `${label}: manifest argv must NOT contain --prompt, got: ${manifestArgs.join(" ")}`);
  assert.equal(
    countFlag(manifestArgs, "--conversation"),
    0,
    `${label}: a fresh attempt must carry no duplicate --conversation (resume_session adds the only one), got: ${manifestArgs.join(" ")}`
  );
  // The prompt reaches the child as the framed stream-json line, never argv.
  assert.equal(stdinSink.text, encodeAgyStdin(PROMPT), `${label}: the prompt must be framed as one stream-json user event`);
  assert.equal(transport.stdin, encodeAgyStdin(PROMPT), `${label}: the transport stdin must be that same framed line`);
}

// A resumed attempt adds resume_session's `--conversation <sid>` exactly once:
// the manifest must not pre-add `--conversation resume` or the flag repeats.
{
  const role = {name: "implementer", adapter: "antigravity", model: null, reasoning: null, resume: true};
  const state = {sessions: {implementer: {sessionId: "agy-sid-092"}}};
  const stdinSink = {text: null};
  const relayArgs = buildRelayArgsForTests(role, manifestAdapter, false, true, state, {promptText: PROMPT, stdinSink});
  const transport = resolveAdapterTransport({driver, profile: null, request: {binary: manifestAdapter.binary, args: relayArgs, stdin: stdinSink.text}});
  assert.equal(transport.available, true, `resume: the transport must resolve available, got: ${transport.reason}`);
  assert.equal(
    countFlag(transport.invocation.args, "--conversation"),
    1,
    `resume: exactly one --conversation, got: ${transport.invocation.args.join(" ")}`
  );
  assert.equal(
    transport.invocation.args[transport.invocation.args.indexOf("--conversation") + 1],
    "agy-sid-092",
    `resume: --conversation must carry the stored session id, got: ${transport.invocation.args.join(" ")}`
  );
  assert.ok(transport.invocation.args.includes("--input-format"), "resume: argv must still carry the stream-json flags");
}

console.log("test-agy-invocation: ALL CHECKS PASSED");
