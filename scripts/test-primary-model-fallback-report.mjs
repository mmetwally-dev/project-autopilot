#!/usr/bin/env node
// Backlog #6(b): a primary model that disappears AFTER mission start is still
// handled by the existing fallback switch, but the WATCH-REPORT and the final
// report must print a loud `primary model not found → using <fallback>` line
// for that role.
//
// Real behavioral proof: a fake opencode reports both models at preflight
// (so the mission starts), then its PRIMARY-model run exits with the CLI's
// own ProviderModelNotFoundError diagnostic. The configured fallback succeeds.
import fs from "node:fs";
import path from "node:path";

import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, setScenario,
  writeConfig, runAutopilot, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import { buildReportModel, renderReport } from "./watch-report.mjs";

const PRIMARY = "primary-model";
const FALLBACK = "fallback-model";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

function fakeOpenCodeSource() {
  return [
    "#!/bin/sh",
    "set -eu",
    'if [ "${1:-}" = "--version" ]; then echo "opencode 1.18.22"; exit 0; fi',
    'if [ "${1:-}" = "--help" ]; then printf "Usage: opencode\\n  --variant <level>\\n"; exit 0; fi',
    'if [ "${1:-}" = "run" ] && [ "${2:-}" = "--help" ]; then printf "Usage: opencode run [message..]\\n  --variant <level>\\n"; exit 0; fi',
    'if [ "${1:-}" = "models" ]; then',
    '  if [ "${2:-}" = "--verbose" ]; then',
    `    printf 'opencode/${PRIMARY}\\n{"name":"Primary","variants":{}}\\n'`,
    `    printf 'opencode/${FALLBACK}\\n{"name":"Fallback","variants":{}}\\n'`,
    "    exit 0",
    "  fi",
    `  printf 'opencode/${PRIMARY}\\nopencode/${FALLBACK}\\n'`,
    "  exit 0",
    "fi",
    'PROMPT="$(cat)"',
    "ROLE=$(printf '%s\\n' \"$PROMPT\" | sed -n '1s/^ROLE=//p')",
    'if [ "$ROLE" = "implementer" ]; then',
    '  case " $* " in',
    `    *" --model ${PRIMARY} "*)`,
    `      printf '%s\\n' 'ProviderModelNotFoundError: Model not found: opencode/${PRIMARY}' >&2`,
    "      exit 1",
    "      ;;",
    `    *" --model ${FALLBACK} "*)`,
    "      mkdir -p output",
    "      printf 'fallback implementation\\n' > output/fallback-implementation.txt",
    "      printf 'implementer ok\\n'",
    `      printf 'AUTOPILOT_TASK_RESULT={"summary":"fallback implementer ok","taskLocalCheck":{"command":"true","status":"passed","exitCode":0,"summary":"fixture"}}\\n'`,
    "      exit 0",
    "      ;;",
    "  esac",
    "fi",
    "exit 1",
    "",
  ].join("\n");
}

function readResults(repo) {
  const results = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "result.json") results.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  })(path.join(repo, ".autopilot"));
  return results.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

const repo = makeFixtureRepo("primary-vanished");
const binDir = makeFixtureBin("primary-vanished");
try {
  fs.writeFileSync(path.join(binDir, "opencode"), fakeOpenCodeSource());
  fs.chmodSync(path.join(binDir, "opencode"), 0o755);

  makeSpecKitPhaseFixture(repo);
  writeConfig(repo, { planningFramework: "speckit" });
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.roles.implementer = {
    ...config.roles.implementer,
    adapter: "opencode",
    model: PRIMARY,
    fallbacks: [{ adapter: "opencode", model: FALLBACK }],
  };
  config.roles.free_models = { auto_fallback: true };
  config.policy.fallback_retry_primary_minutes = 24 * 60;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  setScenario(repo, "success");

  const run = runAutopilot(repo, binDir, {
    request: "implement the fixture task",
    timeoutMs: process.platform === "win32" ? 180000 : 120000,
  });
  const results = readResults(repo);
  const impl = results.filter((r) => r.role === "implementer");
  const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  const output = `${run.stdout || ""}\n${run.stderr || ""}`;

  check("harness: mission completed after the fallback switch (exit 0)", run.status === 0,
    { status: run.status, timedOut: run.timedOut, output: output.slice(-2500) });
  check("harness: two implementer runs (primary, then fallback)",
    impl.length === 2, impl.map((r) => ({ status: r.status, failure: r.failure?.class, model: r.model })));
  if (impl.length >= 2) {
    check("harness: first run failed on the primary model",
      impl[0].model === PRIMARY && impl[0].status !== "completed", { model: impl[0].model, status: impl[0].status });
    check("harness: first run recorded the CLI's model-not-found diagnostic",
      impl[0].modelNotFound === true, { modelNotFound: impl[0].modelNotFound, failure: impl[0].failure });
    check("harness: first run recorded the fallback it moved to",
      impl[0].primaryModelMissing?.fallback?.model === FALLBACK, impl[0].primaryModelMissing);
    check("harness: second run completed on the fallback model",
      impl[1].status === "completed" && impl[1].model === FALLBACK, { status: impl[1].status, model: impl[1].model });
  }

  const record = state.primaryModelFallbacks?.implementer;
  check("state: the mission records the primary/fallback pair",
    record?.primary?.model === PRIMARY && record?.fallback?.model === FALLBACK, record);

  check("console: the switch prints the loud line", /primary model not found → using opencode\/fallback-model/.test(output),
    output.slice(-2500));
  check("final report: mission completion repeats the loud line",
    (output.match(/primary model not found → using opencode\/fallback-model/g) || []).length >= 2,
    output.slice(-2500));

  // The WATCH-REPORT is the mission's final report: it must still carry the
  // line after the mission has completed and the fallback run succeeded.
  const reportPath = path.join(repo, ".autopilot", "missions", state.mission, "WATCH-REPORT.md");
  const reportText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
  check("WATCH-REPORT: final file exists", fs.existsSync(reportPath), reportPath);
  check("WATCH-REPORT: prints `primary model not found → using opencode/fallback-model`",
    reportText.includes("primary model not found → using opencode/fallback-model"), reportText.slice(-2500));
  check("WATCH-REPORT: the line names the role and the configured primary",
    /primary model not found → using opencode\/fallback-model for implementer \(configured opencode\/primary-model\)/.test(reportText),
    reportText.slice(-2500));

  // And the same model renders it directly (independent of the on-disk file
  // refresh), proving the final-report path is driven by the persisted state.
  const model = buildReportModel({ state, runs: [], events: [], phases: [], policy: {}, now: new Date().toISOString() });
  const rendered = renderReport(model);
  check("final report render: prints the same loud line",
    rendered.includes("primary model not found → using opencode/fallback-model for implementer"), rendered);
} finally {
  cleanup(repo, binDir);
}

if (failures) {
  console.error(`${failures} primary-model fallback report check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
