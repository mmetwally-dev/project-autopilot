#!/usr/bin/env node
// Backlog #6(a): at mission start, a role's PRIMARY model must exist in its
// adapter's LIVE model list. A model the CLI actually omitted stops `ap run`
// before any role is launched; a known model passes; a list that could not be
// read/timed out never stops (today's warning stands); and the claude adapter
// (documented aliases, no live list) is never checked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { preflightPrimaryModels, primaryModelPreflightMessage, modelInLiveCatalog } from "./preflight.mjs";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, runAutopilot, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

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

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-primary-preflight-"));
process.on("exit", () => {
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// A real fake `opencode` executable. modes:
//   listed    -> `models --verbose` reports both fixture models
//   unreadable-> the model list command fails (no list obtained)
//   slow      -> the model list command exceeds a short test budget (timeout)
function writeFakeOpenCode(mode = "listed", targetDir = null) {
  const dir = targetDir || fs.mkdtempSync(path.join(temporary, `bin-${mode}-`));
  const script = path.join(dir, "fake-opencode.mjs");
  const log = path.join(dir, "role-runs.log");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    `const mode = ${JSON.stringify(mode)};`,
    `const log = ${JSON.stringify(log)};`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
    'if (args[0] === "--help" || (args[0] === "run" && args[1] === "--help")) {',
    '  process.stdout.write("Usage: opencode run [message..]\\n  -m, --model <name>\\n  --variant <level>\\n");',
    '  process.exit(0);',
    '}',
    'if (args[0] === "models") {',
    '  if (mode === "unreadable") { process.stderr.write("model list unavailable\\n"); process.exit(1); }',
    '  const emit = () => {',
    '    process.stdout.write("opencode/fake-model\\n" + JSON.stringify({name: "Fake", variants: {low: {}, high: {}}}) + "\\n");',
    '    process.stdout.write("opencode/fallback-model\\n" + JSON.stringify({name: "Fallback", variants: {low: {}}}) + "\\n");',
    '    process.exit(0);',
    '  };',
    '  if (mode === "slow") setTimeout(emit, 2000); else emit();',
    '}',
    '// Any real role launch is recorded; the preflight tests must see none.',
    'fs.appendFileSync(log, JSON.stringify(args) + "\\n");',
    'process.exit(1);',
  ].join("\n"));
  let binary;
  if (process.platform === "win32") {
    binary = path.join(dir, "opencode.cmd");
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    binary = path.join(dir, "opencode");
    fs.writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    fs.chmodSync(binary, 0o755);
  }
  return { dir, binary, log, adapter: { ...agents.opencode, binary } };
}

function readRoleRuns(log) {
  try { return fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

// ── A. `ap run` stops before ANY role launch for an unknown primary model ──
for (const framework of ["standalone", "speckit", "gsd"]) {
  const repo = makeFixtureRepo(`primary-unknown-${framework}`);
  const binDir = makeFixtureBin(`primary-unknown-${framework}`);
  try {
    // makeFixtureBin provides the cursor adapter used by every other role;
    // the fake opencode is written into the same bin directory.
    const listed = writeFakeOpenCode("listed", binDir);
    writeConfig(repo, { planningFramework: framework });
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner = {
      ...config.roles.planner,
      adapter: "opencode",
      model: "sonnet[1m]", // a Claude Code name, never in the OpenCode list
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const run = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 120000 });
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    check(`${framework}: unknown primary stops the run (non-zero, not a timeout)`,
      run.status !== 0 && run.timedOut === false, { status: run.status, timedOut: run.timedOut, output: output.slice(-1500) });
    check(`${framework}: error names the role`, output.includes("role 'planner'"), output.slice(-1500));
    check(`${framework}: error names the adapter`, output.includes("adapter 'opencode'"), output.slice(-1500));
    check(`${framework}: error names the model`, output.includes("sonnet[1m]"), output.slice(-1500));
    check(`${framework}: error names the fix`, output.includes("ap config"), output.slice(-1500));
    check(`${framework}: no role was launched`, readRoleRuns(listed.log).length === 0, readRoleRuns(listed.log).slice(0, 3));
    check(`${framework}: no run/result artifact was created`,
      !fs.existsSync(path.join(repo, ".autopilot", "runs")) && !fs.existsSync(path.join(repo, ".autopilot", "missions")),
      fs.readdirSync(path.join(repo, ".autopilot")));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── B. A KNOWN model passes the live-list check ────────────────────────────
{
  const listed = writeFakeOpenCode("listed");
  const result = await preflightPrimaryModels({
    config: { roles: { implementer: { adapter: "opencode", model: "opencode/fake-model" } } },
    agents: { opencode: listed.adapter },
  });
  check("known model: check passes", result.ok === true && result.problems.length === 0, result);

  const bare = await preflightPrimaryModels({
    config: { roles: { implementer: { adapter: "opencode", model: "fake-model" } } },
    agents: { opencode: listed.adapter },
  });
  check("known bare model matches its provider-qualified live id", bare.ok === true, bare);

  const catalog = [{ id: "opencode/fake-model", effortModelIds: { high: "fake-model-high" } }];
  catalog.status = "reported";
  const effort = await preflightPrimaryModels({
    config: { roles: { implementer: { adapter: "opencode", model: "fake-model-high" } } },
    agents: { opencode: listed.adapter },
    discover: async () => catalog,
  });
  check("known effort-specific model id passes", effort.ok === true, effort);
}

// ── C. An UNKNOWN model is reported with role/adapter/model ────────────────
{
  const listed = writeFakeOpenCode("listed");
  const config = { roles: { implementer: { adapter: "opencode", model: "sonnet[1m]" } } };
  const result = await preflightPrimaryModels({ config, agents: { opencode: listed.adapter } });
  check("unknown model: check fails", result.ok === false && result.problems.length === 1, result);
  check("unknown model: problem names role/adapter/model",
    result.problems[0]?.role === "implementer"
      && result.problems[0]?.adapter === "opencode"
      && result.problems[0]?.model === "sonnet[1m]", result.problems[0]);
  const message = primaryModelPreflightMessage(result, { opencode: listed.adapter });
  check("unknown model: message names role, adapter, model and `ap config`",
    message.includes("role 'implementer'") && message.includes("adapter 'opencode'")
      && message.includes("sonnet[1m]") && message.includes("ap config"), message);
}

// ── D. A list that cannot be read never stops the mission ─────────────────
{
  const unreadable = writeFakeOpenCode("unreadable");
  const result = await preflightPrimaryModels({
    config: { roles: { implementer: { adapter: "opencode", model: "sonnet[1m]" } } },
    agents: { opencode: unreadable.adapter },
  });
  check("unreadable list: check does not stop", result.ok === true && result.problems.length === 0, result);
}

// ── E. A TIMED-OUT list never stops the mission ───────────────────────────
{
  const slow = writeFakeOpenCode("slow");
  const previous = process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS;
  process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = "200";
  try {
    const result = await preflightPrimaryModels({
      config: { roles: { implementer: { adapter: "opencode", model: "sonnet[1m]" } } },
      agents: { opencode: slow.adapter },
    });
    check("timed-out list: check does not stop", result.ok === true && result.problems.length === 0, result);
  } finally {
    if (previous === undefined) delete process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS;
    else process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = previous;
  }
}

// ── F. claude is documented, never live-checked, never stopped ────────────
{
  let discovered = false;
  const result = await preflightPrimaryModels({
    config: { roles: { planner: { adapter: "claude", model: "sonnet[1m]" } } },
    agents,
    discover: () => { discovered = true; return []; },
  });
  check("claude: the documented alias is never checked against a live list", result.ok === true && discovered === false, result);
}

// ── G. The matcher accepts both spellings but never invents a model ───────
check("matcher: qualified id matches", modelInLiveCatalog("opencode/fake-model", ["opencode/fake-model"], "opencode") === true);
check("matcher: bare id matches a qualified entry", modelInLiveCatalog("fake-model", ["opencode/fake-model"], "opencode") === true);
check("matcher: absent model does not match", modelInLiveCatalog("sonnet[1m]", ["opencode/fake-model"], "opencode") === false);

if (failures) {
  console.error(`${failures} primary-model preflight check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
