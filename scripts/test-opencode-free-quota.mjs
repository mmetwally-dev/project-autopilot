#!/usr/bin/env node
// Backlog #14: opencode's free-tier quota rejection has NO status 429:
//   timestamp=... level=ERROR ... providerID=opencode modelID=<free model>
//   ... error.error="AI_APICallError: Free usage limit reached. Free models
//   work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep
//   going: https://opencode.ai/go"
// It must classify as RATE_LIMITED at once (not wait for the idle clock), so
// free_models.auto_fallback switches the role to its fallback and the model is
// recorded exhausted for the mission. Model prose that merely contains the
// words must stay ordinary output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {createIdleWatch, evaluateIdleWatch, noteIdleStderrText, rateLimitLineInfo} from "./idle-hang-watchdog.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario, writeConfig,
  runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const MODEL = "deepseek-v4.1-flash-free";
const FALLBACK = "fallback-model-free";
const SESSION = "ses_e803a401cffe9KkNCpkxieP35O";
const FREE_QUOTA_LINE = `timestamp=2026-10-28T00:00:50.996Z level=ERROR run=65c65963 message="stream error" providerID=opencode modelID=${MODEL} session.id=${SESSION} small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"`;

// ---------------------------------------------------------------------------
// (a) The exact stderr line is detected by BOTH detectors.
// ---------------------------------------------------------------------------
{
  const driver = adapterDriver("opencode");
  const events = driver.decodeEvents("", FREE_QUOTA_LINE);
  const observations = driver.observe(events, {readPath: "", productionWritePath: "", outsideWritePath: ""});
  const hit = observations.find(o => o.type === "rate_limited");
  check("adapter-drivers: exact stderr line produces a rate_limited observation", Boolean(hit), observations);
  check("adapter-drivers: free-quota reason is recorded", hit?.reason === "free_quota_exhausted", hit);

  const classified = classifyObservedFailure({
    exitCode: 1, stdout: "", stderr: FREE_QUOTA_LINE, startError: null, timedOut: false,
    driverless: false, evidence: observations,
  });
  check("adapter-drivers: classifier returns RATE_LIMITED", classified?.class === "RATE_LIMITED", classified);
  check("adapter-drivers: RATE_LIMITED is infrastructure + not retryable",
    classified?.domain === "infrastructure" && classified?.retryable === false, classified);
  check("adapter-drivers: failure evidence carries the free-quota reason",
    classified?.evidence?.some(e => e?.reason === "free_quota_exhausted"), classified?.evidence);

  const info = rateLimitLineInfo(FREE_QUOTA_LINE);
  check("watchdog: exact stderr line is a rate-limit hit", Boolean(info), info);
  check("watchdog: hit names provider/model and the free-quota reason",
    info?.provider === "opencode" && info?.model === MODEL && info?.reason === "free_quota_exhausted", info);

  // Confirmation is independent of the idle clock (and therefore of any live
  // child): one hit + the normal 60 s gap ends the run as RATE_LIMITED.
  const watch = createIdleWatch({idleHangMs: 10 * 60_000, pid: process.pid, adapter: "opencode", now: 0, startedAtMs: 0});
  noteIdleStderrText(watch, FREE_QUOTA_LINE, 1_000);
  const before = evaluateIdleWatch(watch, {now: 30_000});
  const confirmed = evaluateIdleWatch(watch, {now: 62_000});
  check("watchdog: not fired before the confirmation gap", before.status === "ok", before);
  check("watchdog: fires as rate_limited after the gap", confirmed.status === "rate_limited", confirmed);
  check("watchdog: verdict keeps model + free-quota reason",
    confirmed.model === MODEL && confirmed.reason === "free_quota_exhausted", confirmed);
}

// ---------------------------------------------------------------------------
// (b) Model prose / stdout tool text is NOT quota exhaustion.
// ---------------------------------------------------------------------------
{
  const prose = `The provider said: ${FREE_QUOTA_LINE}`;
  const stdoutEvents = [
    {type: "text", part: {type: "text", text: prose}},
    {type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {}, output: prose}}},
  ];
  const driver = adapterDriver("opencode");
  const observations = driver.observe(stdoutEvents, {});
  check("prose: no rate_limited observation from stdout text/tool events",
    !observations.some(o => o.type === "rate_limited"), observations);

  const decoded = driver.decodeEvents(JSON.stringify({type: "text", part: {type: "text", text: prose}}), "");
  const decodedObs = driver.observe(decoded, {});
  check("prose: a decoded stdout text event is not rate_limited",
    !decodedObs.some(o => o.type === "rate_limited"), decodedObs);
  const proseClassified = classifyObservedFailure({
    exitCode: 1, stdout: JSON.stringify({type: "text", part: {type: "text", text: prose}}), stderr: "",
    startError: null, timedOut: false, driverless: false, evidence: decodedObs,
  });
  check("prose: classifier does not report RATE_LIMITED", proseClassified?.class !== "RATE_LIMITED", proseClassified);

  check("watchdog: words without the engine error source are not a hit",
    rateLimitLineInfo("the model wrote: Free usage limit reached; subscribe to OpenCode Go to keep going") === null);
  check("watchdog: a JSON stdout event quoting the log line is not a hit",
    rateLimitLineInfo(JSON.stringify({type: "text", part: {type: "text", text: prose}})) === null);
  const noSource = "level=ERROR message=\"stream error\" providerID=opencode modelID=free error.error=\"Free usage limit reached\"";
  check("watchdog: no AI_APICallError/AI_RetryError source => not a hit", rateLimitLineInfo(noSource) === null);
  const driverNoSource = driver.observe(driver.decodeEvents("", noSource), {});
  check("adapter-drivers: stderr without the engine error source => not rate_limited",
    !driverNoSource.some(o => o.type === "rate_limited"), driverNoSource);
}

// ---------------------------------------------------------------------------
// (c) Real workflow harness: the implementer's fake opencode emits the line,
// the role switches to its configured fallback without an infrastructure
// retry on the same model, and the exhausted model is recorded.
// ---------------------------------------------------------------------------
function fakeOpenCodeSource() {
  return [
    "#!/bin/sh",
    "set -eu",
    'if [ "${1:-}" = "--version" ]; then echo "opencode 1.18.22"; exit 0; fi',
    'PROMPT="$(cat)"',
    "ROLE=$(printf '%s\\n' \"$PROMPT\" | sed -n '1s/^ROLE=//p')",
    'if [ "$ROLE" = "implementer" ]; then',
    '  FLAG="./.autopilot/.autopilot-test-free-quota-emitted"',
    '  if [ ! -f "$FLAG" ]; then',
    '    mkdir -p ./.autopilot',
    '    : > "$FLAG"',
    "    printf '%s\\n' '" + FREE_QUOTA_LINE + "' >&2",
    "    exit 1",
    "  fi",
    "  mkdir -p output",
    "  printf 'fallback implementation\\n' > output/fallback-implementation.txt",
    "  printf 'implementer ok\\n'",
    "  printf 'AUTOPILOT_TASK_RESULT={\"summary\":\"fallback implementer ok\",\"taskLocalCheck\":{\"command\":\"true\",\"status\":\"passed\",\"exitCode\":0,\"summary\":\"fixture\"}}\\n'",
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n");
}

function freeQuotaBin(prefix) {
  const binDir = makeFixtureBin(prefix);
  const target = path.join(binDir, "opencode");
  fs.writeFileSync(target, fakeOpenCodeSource());
  fs.chmodSync(target, 0o755);
  return binDir;
}

function readResults(repo) {
  const results = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") results.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  })(path.join(repo, ".autopilot"));
  return results.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

{
  const repo = makeFixtureRepo("free-quota");
  const binDir = freeQuotaBin("free-quota");
  try {
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.implementer = {
      ...config.roles.implementer,
      adapter: "opencode",
      model: MODEL,
      fallbacks: [{adapter: "opencode", model: FALLBACK}],
    };
    config.roles.free_models = {auto_fallback: true};
    config.policy.fallback_retry_primary_minutes = 24 * 60;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "success");

    const run = runAutopilot(repo, binDir, {
      request: "implement the fixture task",
      timeoutMs: process.platform === "win32" ? 180000 : 120000,
    });
    const results = readResults(repo);
    const impl = results.filter(r => r.role === "implementer");
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;

    check("harness: mission completed after the fallback switch (exit 0)", run.status === 0,
      {status: run.status, timedOut: run.timedOut, output: output.slice(-2500)});
    check("harness: exactly two implementer runs (primary then fallback, no same-model infra retry)",
      impl.length === 2, impl.map(r => ({status: r.status, failure: r.failure?.class, model: r.model})));
    if (impl.length >= 2) {
      check("harness: first implementer run is RATE_LIMITED on the primary",
        impl[0].failure?.class === "RATE_LIMITED" && impl[0].model === MODEL,
        {failure: impl[0].failure, model: impl[0].model});
      check("harness: first run's evidence names the free quota",
        impl[0].failure?.evidence?.some(e => e?.reason === "free_quota_exhausted"), impl[0].failure?.evidence);
      check("harness: second implementer run completed on the fallback model",
        impl[1].status === "completed" && impl[1].model === FALLBACK,
        {status: impl[1].status, model: impl[1].model, failure: impl[1].failure});
    }
    check("harness: exhausted model recorded for the mission",
      Boolean(state.exhaustedModels?.[`opencode/${MODEL}`]), state.exhaustedModels);
    check("harness: exhausted record names the implementer and RATE_LIMITED",
      state.exhaustedModels?.[`opencode/${MODEL}`]?.by === "implementer"
        && state.exhaustedModels?.[`opencode/${MODEL}`]?.reason === "RATE_LIMITED",
      state.exhaustedModels?.[`opencode/${MODEL}`]);
    check("harness: per-role tried-free-model record contains the primary",
      Array.isArray(state.triedFreeModels?.implementer) && state.triedFreeModels.implementer.includes(`opencode/${MODEL}`),
      state.triedFreeModels);
    check("harness: no infrastructure retry budget was spent on the same model",
      state.failureBudgets?.["infrastructureRetryBudget:mission"] === undefined, state.failureBudgets);
    check("harness: log says the free quota is used up and names the fallback model",
      output.includes("free quota used up") && output.includes(MODEL) && output.includes(FALLBACK),
      output.slice(-2500));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} opencode free-quota check(s) failed.`);
  process.exit(1);
}
console.log("test-opencode-free-quota: all cases passed");
