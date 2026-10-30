#!/usr/bin/env node
// Backlog #107 / mission 002 (2026-10-28): opencode's small title-generation
// model (small=true agent=title) can fail with "Insufficient account funds".
// That stderr line says nothing about the role's own model: a run that
// FINISHED with a valid result must stay completed, with no RATE_LIMITED
// failure, no exhausted mark and no model switch. The same text WITHOUT the
// title/small markers is a genuine role-model quota line and still
// classifies RATE_LIMITED. Model prose quoting either line stays ignored.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {OPENCODE_TITLE_MODEL_LINE_RE, rateLimitLineInfo} from "./idle-hang-watchdog.mjs";
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

const here = path.dirname(fileURLToPath(import.meta.url));
const TITLE_LINE = fs.readFileSync(path.join(here, "test-fixtures", "opencode-title-agent-funds.stderr.txt"), "utf8").trim();
// Same diagnostic, but attributed to the role's own model instead of the
// small title agent.
const ROLE_LINE = TITLE_LINE.replace(/\bsmall=true\b/, "small=false").replace(/\bagent=title\b/, "agent=build");
const MODEL = "deepseek-v4.1-flash-free";
const FALLBACK = "fallback-model-free";
const driver = adapterDriver("opencode");

// ---------------------------------------------------------------------------
// (a) The real title-agent line is shared-ignored by BOTH stderr scanners.
// ---------------------------------------------------------------------------
{
  check("shared constant: title line matches", OPENCODE_TITLE_MODEL_LINE_RE.test(TITLE_LINE));
  check("shared constant: role line does not match", !OPENCODE_TITLE_MODEL_LINE_RE.test(ROLE_LINE));
  check("watchdog: title line is not a rate-limit hit", rateLimitLineInfo(TITLE_LINE) === null);

  const titleEvents = driver.decodeEvents("", TITLE_LINE);
  check("adapter-drivers: title line decodes to one stderr event",
    titleEvents.length === 1 && titleEvents[0].type === "stderr", titleEvents);
  const titleObs = driver.observe(titleEvents, {});
  check("adapter-drivers: title line produces no rate_limited observation",
    !titleObs.some(o => o.type === "rate_limited"), titleObs);

  // A completed run with this line on stderr has no observed failure class.
  const titleClassified = classifyObservedFailure({
    exitCode: 0, stdout: "", stderr: TITLE_LINE, startError: null, timedOut: false,
    driverless: false, evidence: titleObs,
  });
  check("classifier: completed run with a valid result keeps no failure class", titleClassified === null, titleClassified);
}

// ---------------------------------------------------------------------------
// (b) A real role-model quota line (no title/small markers) still classifies.
// ---------------------------------------------------------------------------
{
  check("watchdog: role line is still a rate-limit hit", rateLimitLineInfo(ROLE_LINE) !== null, rateLimitLineInfo(ROLE_LINE));

  const roleEvents = driver.decodeEvents("", ROLE_LINE);
  const roleObs = driver.observe(roleEvents, {});
  const roleHit = roleObs.find(o => o.type === "rate_limited");
  check("adapter-drivers: role line still produces a rate_limited observation", Boolean(roleHit), roleObs);
  check("adapter-drivers: role line keeps the stderr reason",
    roleHit?.reason === "opencode_stderr_rate_limit", roleHit);

  const roleClassified = classifyObservedFailure({
    exitCode: 0, stdout: "", stderr: ROLE_LINE, startError: null, timedOut: false,
    driverless: false, evidence: roleObs,
  });
  check("classifier: role line still classifies RATE_LIMITED",
    roleClassified?.class === "RATE_LIMITED", roleClassified);
  check("classifier: RATE_LIMITED stays infrastructure + not retryable",
    roleClassified?.domain === "infrastructure" && roleClassified?.retryable === false, roleClassified);
}

// ---------------------------------------------------------------------------
// (c) Model prose quoting either line stays ignored.
// ---------------------------------------------------------------------------
{
  for (const [name, line] of [["title", TITLE_LINE], ["role", ROLE_LINE]]) {
    const prose = `The provider said: ${line}`;
    const eventLine = JSON.stringify({type: "text", part: {type: "text", text: prose}});
    const decoded = driver.decodeEvents(eventLine, "");
    const obs = driver.observe(decoded, {});
    check(`prose (${name}): a stdout text event quoting the line is not rate_limited`,
      !obs.some(o => o.type === "rate_limited"), obs);
    check(`prose (${name}): the watchdog ignores the JSON stdout event`, rateLimitLineInfo(eventLine) === null);
  }
}

// ---------------------------------------------------------------------------
// (d) Real workflow: a completed implementer run that emits the title line on
// stderr stays completed, with no exhausted mark and no model switch.
// ---------------------------------------------------------------------------
function fakeOpenCodeSource() {
  return [
    "#!/bin/sh",
    "set -eu",
    'if [ "${1:-}" = "--version" ]; then echo "opencode 1.18.22"; exit 0; fi',
    'PROMPT="$(cat)"',
    "ROLE=$(printf '%s\\n' \"$PROMPT\" | sed -n '1s/^ROLE=//p')",
    'if [ "$ROLE" = "implementer" ]; then',
    "  mkdir -p output",
    "  printf 'title-agent implementation\\n' > output/title-agent-implementation.txt",
    "  printf '%s\\n' '" + TITLE_LINE + "' >&2",
    "  RESULT='AUTOPILOT_TASK_RESULT={\\\"summary\\\":\\\"title-agent implementer ok\\\",\\\"taskLocalCheck\\\":{\\\"command\\\":\\\"true\\\",\\\"status\\\":\\\"passed\\\",\\\"exitCode\\\":0,\\\"summary\\\":\\\"fixture\\\"}}'",
    "  printf '{\"type\":\"text\",\"part\":{\"type\":\"text\",\"text\":\"%s\"}}\\n' \"$RESULT\"",
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n");
}

function titleAgentBin(prefix) {
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
  const repo = makeFixtureRepo("title-agent");
  const binDir = titleAgentBin("title-agent");
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

    check("harness: mission completed (exit 0)", run.status === 0,
      {status: run.status, timedOut: run.timedOut, output: output.slice(-2500)});
    check("harness: exactly one implementer run (no model switch)",
      impl.length === 1, impl.map(r => ({status: r.status, failure: r.failure?.class, model: r.model})));
    if (impl.length >= 1) {
      check("harness: implementer run stays completed",
        impl[0].status === "completed", {status: impl[0].status, failure: impl[0].failure});
      check("harness: implementer run carries no failure class",
        !impl[0].failure, impl[0].failure);
      check("harness: implementer stayed on the configured model",
        impl[0].model === MODEL, impl[0].model);
    }
    check("harness: no model marked exhausted",
      !state.exhaustedModels?.[`opencode/${MODEL}`], state.exhaustedModels);
    check("harness: no tried-free-model switch recorded for the implementer",
      !Array.isArray(state.triedFreeModels?.implementer) || state.triedFreeModels.implementer.length === 0,
      state.triedFreeModels);
    check("harness: output never reports RATE_LIMITED",
      !output.includes("RATE_LIMITED"), output.slice(-2500));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} opencode title-agent error check(s) failed.`);
  process.exit(1);
}
console.log("test-opencode-title-agent-error: all cases passed");
