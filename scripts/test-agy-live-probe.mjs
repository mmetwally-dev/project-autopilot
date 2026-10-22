#!/usr/bin/env node
// Task 1.5: the live agy probe — the one place in the agy transport suite
// that spawns the REAL installed agy. Everything else (test-agy-invocation,
// -events, -wire and -transport) proves the argv/stdin/event contract offline
// against scripted fake-agy fixtures; this file checks those offline
// assumptions against the binary that actually has to accept them:
//
//   - the binary resolves on PATH and reports a version,
//   - every flag our argv emits is real agy CLI surface (`agy --help`),
//   - AGY_SETTINGS_RELATIVE_PATH still points at the real agy config
//     location under the operator's HOME, and the per-run allow-rule writer
//     stays inside the run's own scratch dir so that real file is never
//     touched,
//   - one trivial plan-mode mission run: the stdout stream decodes, the
//     terminal result is SUCCESS, the agent_response usage tokens accumulate,
//     and observation never throws.
//
// It spends a single trivial model call on the operator's real credentials and
// shares the real on-disk agy state, so scripts/suite-schedule.mjs lists it in
// realCliTests — the suite gates it with the other real-CLI tests
// (--skip-live / AP_TEST_SKIP_LIVE=1). An environment with no agy on PATH is a
// missing host prerequisite, not a transport failure: that is a clean skip
// (exit 0), never a red test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {adapterDriver, AGY_SETTINGS_RELATIVE_PATH, accumulateUsage} from "./adapter-drivers.mjs";
import {writeAgyAllowRule} from "./agy-events.mjs";

const isOnPath = binary => spawnSync(process.platform === "win32" ? "where" : "which", [binary], {encoding: "utf8", timeout: 30000}).status === 0;

if (!isOnPath("agy")) {
  console.log("test-agy-live-probe: SKIP — no `agy` binary on PATH here, so there is no real agy to probe. The offline fixtures in scripts/test-agy-invocation.mjs, scripts/test-agy-events.mjs, scripts/test-agy-wire.mjs and scripts/test-agy-transport.mjs still cover the argv/stdin/event contract.");
  process.exit(0);
}

const which = spawnSync(process.platform === "win32" ? "where" : "which", ["agy"], {encoding: "utf8", timeout: 30000});
const agyPath = String(which.stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
const driver = adapterDriver("antigravity");
assert.ok(driver, 'adapterDriver("antigravity") must resolve to a driver');
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-probe-"));

try {
  // ── 1. The real binary resolves and reports a version ───────────────────
  assert.ok(agyPath && fs.existsSync(agyPath), `agy must resolve to an existing file on PATH, got: ${agyPath}`);
  const version = spawnSync(agyPath, ["--version"], {encoding: "utf8", timeout: 60000});
  assert.equal(version.status, 0, `agy --version must exit 0, got status=${version.status} stderr=${version.stderr}`);
  assert.match(String(version.stdout), /\d+\.\d+/, `agy --version must print a version, got: ${version.stdout}`);

  // ── 2. Every flag the driver emits is real agy CLI surface ──────────────
  // Cheap and offline-safe: it catches an argv flag our code invents that the
  // real CLI would reject, before the live mission run below spends budget.
  const help = spawnSync(agyPath, ["--help"], {encoding: "utf8", timeout: 60000});
  assert.equal(help.status, 0, `agy --help must exit 0, got status=${help.status} stderr=${help.stderr}`);
  const helpText = `${help.stdout}${help.stderr}`;
  for (const mode of ["write", "scratch", "read_only"]) {
    const invocation = driver.buildInvocation({binary: "agy", mode, model: "m", reasoning: "high", scratchDir: root});
    assert.equal(invocation.binary, "agy", `binary must pass through (mode=${mode})`);
    assert.ok(
      !invocation.args.includes("--dangerously-skip-permissions"),
      `${mode}: the real agy must be driven by the per-run allow-rule settings file, never an auto-approve flag, got: ${invocation.args.join(" ")}`
    );
    for (let i = 0; i < invocation.args.length; i += 1) {
      const arg = invocation.args[i];
      if (!arg.startsWith("--")) continue;
      // Value-bearing flags only: a bare flag name must appear verbatim in the
      // CLI's own help text, which proves it is real agy surface.
      const next = invocation.args[i + 1];
      if (next != null && !next.startsWith("--")) {
        assert.ok(helpText.includes(arg), `${mode}: agy --help must document ${arg} (argv carries it), got an argv flag the real CLI does not list`);
      }
    }
    assert.ok(
      helpText.includes("--dangerously-skip-permissions"),
      `${mode}: agy --help must still advertise --dangerously-skip-permissions, so this assertion proves it is a deliberate choice not to pass it`
    );
  }

  // ── 3. The settings-path constant points at the real agy config dir ─────
  const realSettingsPath = path.join(os.homedir(), AGY_SETTINGS_RELATIVE_PATH);
  assert.ok(
    fs.existsSync(path.dirname(realSettingsPath)),
    `the real agy config directory must exist at ${path.dirname(realSettingsPath)} — AGY_SETTINGS_RELATIVE_PATH (${AGY_SETTINGS_RELATIVE_PATH}) must be the documented location`
  );
  // Sparse file: the CLI persists only non-default values, so the file itself
  // may legitimately be absent. Whatever is there now is the operator's own
  // settings, and writing a per-run allow rule must not touch it.
  const settingsBefore = fs.existsSync(realSettingsPath) ? fs.readFileSync(realSettingsPath, "utf8") : null;

  // ── 4. The per-run allow-rule writer stays inside the run's own scratch ─
  const scratchDir = path.join(root, "mission-scratch");
  fs.mkdirSync(scratchDir, {recursive: true});
  const allowRulePath = writeAgyAllowRule(scratchDir);
  assert.equal(allowRulePath, path.join(scratchDir, AGY_SETTINGS_RELATIVE_PATH), "the allow rule must land at the documented settings path inside the run's own scratch dir");
  const written = JSON.parse(fs.readFileSync(allowRulePath, "utf8"));
  assert.ok(Array.isArray(written?.permissions?.allow) && written.permissions.allow.length > 0, "the written settings file must carry a permissions.allow list");
  for (const rule of written.permissions.allow) {
    assert.ok(String(rule).includes(scratchDir), `every allow rule must be scoped to the run's own scratch dir, got: ${rule}`);
  }
  const settingsAfter = fs.existsSync(realSettingsPath) ? fs.readFileSync(realSettingsPath, "utf8") : null;
  assert.equal(settingsAfter, settingsBefore, "writing the per-run allow rule must leave the operator's real agy settings file byte-identical");

  // ── 5. One live plan-mode mission run through the real driver ──────────
  // plan (read_only) needs no command grant and writes no settings file, so
  // the run cannot widen permissions; the prompt is trivial and the answer is
  // never content-asserted — this proves the transport, not the model.
  const PROMPT = "Reply with the single word: OK";
  const framed = driver.encodeStdin(PROMPT);
  assert.ok(framed.endsWith("\n"), "the framed stdin must be one newline-terminated NDJSON line");
  assert.deepEqual(
    JSON.parse(framed.trim()),
    {event: "user", message: {content: PROMPT}},
    "the real agy must be handed one {event:user,message:{content}} NDJSON line"
  );
  const invocation = driver.buildInvocation({binary: "agy", mode: "read_only", model: null, reasoning: "low", scratchDir});
  assert.equal(invocation.settingsPath, null, "read_only must claim no per-run settings file");
  const live = spawnSync(agyPath, invocation.args, {
    input: framed,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 240000,
    cwd: scratchDir,
    maxBuffer: 32 * 1024 * 1024
  });
  assert.equal(
    live.status,
    0,
    `the real agy must accept the driver argv + stdin framing, got status=${live.status} signal=${live.signal} stderr=${live.stderr}`
  );
  const events = driver.decodeEvents(live.stdout, live.stderr);
  assert.ok(events.some(event => event.event === "init"), "the real agy stream must carry an init event");
  const agentResponses = events.filter(event => event.event === "step_update" && event.step_update?.step_type === "agent_response");
  assert.ok(agentResponses.length > 0, `the real agy stream must carry at least one agent_response step_update, got: ${events.map(e => e.event).join(",")}`);
  const terminal = events.filter(event => event.event === "result").at(-1);
  assert.ok(terminal, `the real agy stream must carry a terminal result event, got: ${events.map(e => e.event).join(",")}`);
  assert.equal(terminal.result.status, "SUCCESS", `the live mission must succeed, got status=${terminal.result.status} error=${terminal.result.error || ""}`);
  assert.ok(String(terminal.result.response ?? "").trim().length > 0, "the real agy must answer the live prompt");
  const conversationIds = new Set(events.map(event => event.conversation_id).filter(Boolean));
  assert.ok(conversationIds.size === 1, `every live event must share one conversation_id, got: ${[...conversationIds].join(",")}`);
  const observations = driver.observe(events, {readPath: "", productionWritePath: "", outsideWritePath: ""});
  assert.ok(Array.isArray(observations), "the live stream must observe without throwing");
  const usage = accumulateUsage("antigravity", events);
  assert.ok(usage, `the live agy stream must accumulate usage, got: ${JSON.stringify(usage)}`);
  assert.ok(usage.input > 0, `the live agent_response usage must report input tokens, got: ${JSON.stringify(usage)}`);
  assert.ok(usage.output >= 0 && usage.turns >= 1, `the live usage must carry non-negative output and at least one turn, got: ${JSON.stringify(usage)}`);
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

console.log("test-agy-live-probe: ALL CHECKS PASSED");
