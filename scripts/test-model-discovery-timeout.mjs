#!/usr/bin/env node
// Backlog #5: a slow-but-valid `opencode models --verbose` (30 s budget) must
// be reported as a timeout, not as "this CLI has no machine-readable list".
// The same distinction must survive into `ap setup` (--wizard) and
// `ap config` (--edit), while a genuinely unsupported CLI keeps the old
// message.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {discoverModelCatalog, MODEL_DISCOVERY_TIMEOUT_MS, modelDiscoveryTimeoutLabel} from "./model-discovery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const setupScript = path.join(here, "setup.mjs");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-model-timeout-"));
const previousPath = process.env.PATH;
const previousTimeout = process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS;
const testTimeoutMs = 1000;
const generousTimeoutMs = 30000;
// Clearly above the doubled retry budget (2 x 1000 ms) so the always-slow
// fake still times out on BOTH attempts.
const slowDelayMs = 3500;
const slowFirstDelayMs = 1500;

process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = String(generousTimeoutMs);

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const systemDirs = process.platform === "win32"
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ["/usr/bin", "/bin"];

function pathWith(binDir) {
  return [binDir, ...systemDirs].join(path.delimiter);
}

function makeBin(dir, name, scriptPath) {
  if (process.platform === "win32") {
    const bin = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return bin;
  }
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function writeFakeOpencode({mode, delayMs = 0}) {
  const dir = fs.mkdtempSync(path.join(scratch, `bin-${mode}-`));
  const script = path.join(dir, "fake-opencode.mjs");
  // Counter lives in the fake's own temp dir so a retry (a new process) can
  // tell it is no longer the cold first call.
  const counterPath = path.join(dir, "models-calls.txt");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    `const mode = ${JSON.stringify(mode)};`,
    `const delayMs = ${Number(delayMs)};`,
    `const counterPath = ${JSON.stringify(counterPath)};`,
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
    'if (args[0] === "--help") { process.stdout.write("Usage: opencode\\n  -m, --model <name>\\n      --variant <level>\\n"); process.exit(0); }',
    'if (args[0] === "models") {',
    '  if (mode === "unsupported") process.exit(0);',
    '  const emit = () => {',
    '    process.stdout.write("provider/model-a\\n" + JSON.stringify({name:"Model A", variants:{low:{},high:{}}}) + "\\n");',
    "    process.exit(0);",
    "  };",
    '  if (mode === "slow") { setTimeout(emit, delayMs); }',
    '  else if (mode === "slowFirst") {',
    '    let calls = 0;',
    '    try { calls = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}',
    "    calls += 1;",
    '    fs.writeFileSync(counterPath, String(calls));',
    '    if (calls === 1) setTimeout(emit, delayMs); else emit();',
    "  } else emit();",
    "}",
    'if (args[0] !== "models") process.exit(0);'
  ].join("\n"));
  makeBin(dir, "opencode", script);
  return dir;
}

function runSetup({binDir, repo, args, timeoutMs = generousTimeoutMs}) {
  const r = spawnSync(process.execPath, [setupScript, ...args, "--repo", repo], {
    cwd: root,
    env: {
      ...process.env,
      PATH: pathWith(binDir),
      AP_MODEL_DISCOVERY_TIMEOUT_MS: String(timeoutMs),
      AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"
    },
    input: Array(320).fill("").join("\n"),
    encoding: "utf8",
    timeout: 120000
  });
  return {
    status: r.status,
    signal: r.signal,
    error: r.error,
    output: `${r.stdout || ""}\n${r.stderr || ""}`
  };
}

function assertSetupCompleted(label, run) {
  assert.equal(run.error, undefined, `${label}: setup failed to spawn: ${run.error?.message}\n${run.output.slice(-2000)}`);
  assert.equal(run.signal, null, `${label}: setup was killed by ${run.signal}\n${run.output.slice(-2000)}`);
  assert.equal(run.status, 0, `${label}: setup exited ${run.status}\n${run.output.slice(-2000)}`);
}

try {
  // ── 0. The production model-list budget is 30 s, not the old 10 s ──
  assert.equal(MODEL_DISCOVERY_TIMEOUT_MS, 30000, "model discovery must keep a 30 s production budget");
  assert.equal(modelDiscoveryTimeoutLabel(30000), "30 s");

  // ── 1. Slow discovery: empty catalog, explicit timeout status ──
  process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = String(testTimeoutMs);
  const slowBin = writeFakeOpencode({mode: "slow", delayMs: slowDelayMs});
  process.env.PATH = pathWith(slowBin);
  const slow = await discoverModelCatalog({binary: "opencode", model_discovery: "opencode_models"});
  assert.ok(Array.isArray(slow), "slow discovery must still return an array");
  assert.equal(slow.length, 0, "timed-out discovery must return no invented models");
  assert.equal(slow.status, "timeout", "slow discovery must report status=timeout");
  console.log("PASS: slow model list reports status=timeout");

  // ── 2. `ap setup` (--wizard) names the timeout, not "does not expose" ──
  const slowRepo = fs.mkdtempSync(path.join(scratch, "repo-slow-"));
  const wizard = runSetup({binDir: slowBin, repo: slowRepo, args: ["--wizard"], timeoutMs: testTimeoutMs});
  assertSetupCompleted("slow wizard", wizard);
  assert.match(wizard.output, /Loading opencode models…/, "setup must announce the model-list probe");
  assert.match(wizard.output, /opencode is slow to answer \(first start can take a while\) — trying again for up to 2 s…/, `expected the retry line, got:\n${wizard.output.slice(-3000)}`);
  assert.match(wizard.output, /opencode model list timed out after 1 s/, `expected the timeout message, got:\n${wizard.output.slice(-3000)}`);
  const wizardRetryAt = wizard.output.indexOf("is slow to answer");
  const wizardTimeoutAt = wizard.output.indexOf("model list timed out after");
  assert.ok(wizardRetryAt >= 0 && wizardTimeoutAt > wizardRetryAt, "the retry line must come before the timeout message");
  assert.equal((wizard.output.match(/is slow to answer/g) || []).length, 1, "an always-slow CLI must be retried exactly once");
  assert.equal((wizard.output.match(/model list timed out after/g) || []).length, 1, "an always-slow CLI must report the timeout once");
  assert.doesNotMatch(wizard.output, /does not expose a supported machine-readable model list/, "a timeout must not be reported as an unsupported CLI");

  // ── 3. `ap config` (--edit) retries and then uses the same timeout message ──
  const edit = runSetup({binDir: slowBin, repo: slowRepo, args: ["--edit"], timeoutMs: testTimeoutMs});
  assertSetupCompleted("slow edit", edit);
  assert.match(edit.output, /opencode is slow to answer \(first start can take a while\) — trying again for up to 2 s…/, `expected the retry line in ap config, got:\n${edit.output.slice(-3000)}`);
  assert.match(edit.output, /opencode model list timed out after 1 s/, `expected the timeout message in ap config, got:\n${edit.output.slice(-3000)}`);
  assert.equal((edit.output.match(/model list timed out after/g) || []).length, 1, "ap config must report the timeout once");
  assert.doesNotMatch(edit.output, /does not expose a supported machine-readable model list/, "ap config must not call a timeout unsupported");

  // ── 3b. First call slower than the budget, retry fast: real catalog wins ──
  const slowFirstBin = writeFakeOpencode({mode: "slowFirst", delayMs: slowFirstDelayMs});
  process.env.PATH = pathWith(slowFirstBin);
  const slowFirstRepo = fs.mkdtempSync(path.join(scratch, "repo-slow-first-"));
  const slowFirstRun = runSetup({binDir: slowFirstBin, repo: slowFirstRepo, args: ["--wizard"], timeoutMs: testTimeoutMs});
  assertSetupCompleted("slow-first wizard", slowFirstRun);
  assert.match(slowFirstRun.output, /opencode is slow to answer \(first start can take a while\) — trying again for up to 2 s…/, `expected the retry line, got:\n${slowFirstRun.output.slice(-3000)}`);
  assert.match(slowFirstRun.output, /model \(live discovery from opencode\)/, `retry success must show the real live model list:\n${slowFirstRun.output.slice(-3000)}`);
  assert.match(slowFirstRun.output, /Model A/, `retry success must offer the discovered model:\n${slowFirstRun.output.slice(-3000)}`);
  assert.doesNotMatch(slowFirstRun.output, /timed out after/, "a successful retry must not print a timeout");
  assert.doesNotMatch(slowFirstRun.output, /model \(blank = let opencode choose its default\)/, "a successful retry must not fall back to the free-text model prompt");
  assert.ok(Number(fs.readFileSync(path.join(slowFirstBin, "models-calls.txt"), "utf8")) >= 2, "the fake must have seen the first slow call and the retry");

  // ── 4. Fast discovery still returns the real catalog ──
  process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = String(generousTimeoutMs);
  const fastBin = writeFakeOpencode({mode: "fast"});
  process.env.PATH = pathWith(fastBin);
  const fast = await discoverModelCatalog({binary: "opencode", model_discovery: "opencode_models"});
  assert.equal(fast.status, "reported", "fast discovery must report status=reported");
  assert.equal(fast.length, 1, "fast discovery must return the exposed model");
  assert.equal(fast[0].id, "provider/model-a");
  assert.deepEqual(fast[0].variants, ["low", "high"]);
  const fastRepo = fs.mkdtempSync(path.join(scratch, "repo-fast-"));
  const fastRun = runSetup({binDir: fastBin, repo: fastRepo, args: ["--wizard"]});
  assertSetupCompleted("fast wizard", fastRun);
  assert.match(fastRun.output, /live discovery from opencode/, `fast setup must use the live catalog:\n${fastRun.output.slice(-3000)}`);
  assert.doesNotMatch(fastRun.output, /timed out after/, "fast setup must not print a timeout");

  // ── 5. A CLI that truly exposes no list keeps the old message ──
  const unsupportedBin = writeFakeOpencode({mode: "unsupported"});
  process.env.PATH = pathWith(unsupportedBin);
  const unsupported = await discoverModelCatalog({binary: "opencode", model_discovery: "opencode_models"});
  assert.equal(unsupported.status, "unsupported", "empty output must report status=unsupported");
  assert.equal(unsupported.length, 0);
  const unsupportedRepo = fs.mkdtempSync(path.join(scratch, "repo-unsupported-"));
  const unsupportedRun = runSetup({binDir: unsupportedBin, repo: unsupportedRepo, args: ["--wizard"]});
  assertSetupCompleted("unsupported wizard", unsupportedRun);
  assert.match(unsupportedRun.output, /does not expose a supported machine-readable model list/, `expected the old unsupported message:\n${unsupportedRun.output.slice(-3000)}`);
  assert.doesNotMatch(unsupportedRun.output, /timed out after/, "unsupported must not be reported as a timeout");
  assert.doesNotMatch(unsupportedRun.output, /is slow to answer/, "unsupported discovery must never be retried");

  console.log("model discovery timeout tests passed");
} finally {
  if (previousPath == null) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousTimeout == null) delete process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS;
  else process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = previousTimeout;
  fs.rmSync(scratch, {recursive: true, force: true});
}
