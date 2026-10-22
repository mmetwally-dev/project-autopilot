#!/usr/bin/env node
// Backlog #105: a recorded phase gate result (pass OR fail) is reused on a
// verifier infrastructure retry and on stop+resume at verify while the phase
// delta digest is unchanged; it re-runs when the delta changed.
import fs from "node:fs";
import path from "node:path";
import { makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, runAutopilotUntilMarker, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail === undefined ? "" : " " + JSON.stringify(detail)}`); }
};
const REUSED = "gate result reused (digest unchanged)";
// Counting gate red on its first run only (red results were never cached before #105): a reuse keeps the count at 1 until the implementer fix round, then it runs once more (green).
const RED_GATE = 'mkdir -p .autopilot; echo x >> .autopilot/gate-count; N=$(wc -l < .autopilot/gate-count); if [ "$N" -le 1 ]; then echo RED-MARKER; exit 1; else echo GATE-OK; exit 0; fi';
const GREEN_GATE = 'mkdir -p .autopilot; echo x >> .autopilot/gate-count; echo GATE-OK; exit 0';
const gateCount = (repo) => {
  const f = path.join(repo, ".autopilot", "gate-count");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length : 0;
};
const REQUEST = "implement the fixture task";
const count = (text) => text.split(REUSED).length - 1;

// 1. Verifier infra failure once, red gate: the retry reuses the recorded gate.
{
  const repo = makeFixtureRepo("gate-reuse-infra"), binDir = makeFixtureBin("gate-reuse-infra");
  try {
    writeConfig(repo, {planningFramework: "standalone", gatesCommands: [RED_GATE], networkIsolation: false});
    setScenario(repo, "standalone_verifier_infra_once");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 85000});
    check("infra: reuse line logged on the retry", count(run.stdout) >= 1, run.stdout.slice(-600));
    check("infra: gate ran twice total (red once, reused on retry, green after fix round)", gateCount(repo) === 2, gateCount(repo));
  } finally { cleanup(repo, binDir); }
}

// 2. Stop at verify (killed verifier), resume: a red result is NOT reused after an operator resume (gate re-runs).
{
  const repo = makeFixtureRepo("gate-reuse-resume"), binDir = makeFixtureBin("gate-reuse-resume");
  try {
    writeConfig(repo, {planningFramework: "standalone", gatesCommands: [RED_GATE], networkIsolation: false});
    setScenario(repo, "standalone_verifier_hang");
    const run1 = await runAutopilotUntilMarker(repo, binDir, {request: REQUEST, markerFile: path.join(repo, ".autopilot", ".never-marker"), timeoutMs: 40000});
    check("resume: first run killed mid-verify", run1.killed, {killed: run1.killed});
    check("resume: gate ran once before the stop", gateCount(repo) === 1, gateCount(repo));
    const run2 = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 85000});
    check("resume: no reuse line after an operator resume", count(run2.stdout) === 0, run2.stdout.slice(-600));
    check("resume: gate re-ran on resume (red once, re-run green, no reuse)", gateCount(repo) === 2, gateCount(repo));
  } finally { cleanup(repo, binDir); }
}

// 3. Delta change between rounds: gate re-runs (no reuse).
{
  const repo = makeFixtureRepo("gate-reuse-delta"), binDir = makeFixtureBin("gate-reuse-delta");
  try {
    writeConfig(repo, {planningFramework: "standalone", gatesCommands: [GREEN_GATE], networkIsolation: false});
    setScenario(repo, "standalone_verifier_delta_change");
    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: 85000});
    check("delta: mission completed", run.status === 0, run.status);
    check("delta: gate re-ran after delta change", gateCount(repo) === 2, gateCount(repo));
    check("delta: no reuse line", count(run.stdout) === 0, count(run.stdout));
  } finally { cleanup(repo, binDir); }
}

// 4. Unit: reuse eligibility, key sensitivity to gate execution config, resume clearing.
{
  const {recordLastGateResult, getLastGateResult} = await import("./phase-stage-checkpoint.mjs");
  const cp = {};
  recordLastGateResult(cp, "k", {ok: false, exitCode: 1, shellBlocked: false});
  check("unit: ordinary red test failure is reusable", getLastGateResult(cp, "k")?.ok === false);
  for (const bad of [{ok: false, exitCode: 99, shellBlocked: true}, {ok: false, exitCode: 124}, {ok: false, exitCode: null}, {ok: false, exitCode: 1, timedOut: true}]) {
    recordLastGateResult(cp, "k", {ok: false, exitCode: 1});
    recordLastGateResult(cp, "k", bad);
    check(`unit: not reusable ${JSON.stringify(bad)}`, getLastGateResult(cp, "k") === null);
  }
  recordLastGateResult(cp, "k", {ok: true, exitCode: 0});
  check("unit: green reusable; different key (gates config change) misses", getLastGateResult(cp, "k")?.ok === true && getLastGateResult(cp, "k2") === null);
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("unit: key covers env_allowlist/network_isolation in both loops; resume clears lastGate",
    /env_allowlist\|\|\[\],net:c\.gates\?\.network_isolation!==false/.test(src)
    && (src.match(/getLastGateResult\(checkpoint,lastGateKeyOf\(/g) || []).length === 2
    && (src.match(/recordLastGateResult\(checkpoint,lastGateKeyOf\(/g) || []).length === 2
    && (src.match(/delete checkpoint\.lastGate;\n/g) || []).length === 4);
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log("All gate-reuse-on-retry checks passed.");
