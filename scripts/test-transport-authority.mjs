#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {canonicalJson} from "./capability-contract.mjs";
import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";

// Proves the resolved transport result is the single source of truth:
// 1. For every v2 driver, resolver output === driver.buildInvocation output
//    for identical requests (no rebuild divergence is possible).
// 2. Functional certification and execution-plane safety spawn exactly
//    transport.invocation / feed exactly transport.stdin (static seam check:
//    no parallel buildInvocation remains on either path).
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

// A real, existing native binary is required here (classifyBinary() lstats
// it and, off Windows, binaryAdmission() denies anything unresolved) — this
// test only exercises driver/transport-resolution logic, never actually
// spawns it, so any real executable works. process.execPath (the running
// node binary) is guaranteed to exist on every platform, unlike a hardcoded
// POSIX path such as "/usr/bin/env", which does not exist on Windows.
const PLACEHOLDER_BINARY = process.execPath;

const drivers = [adapterDriver("codex"), adapterDriver("antigravity")].filter(Boolean);
check("both v2 drivers are present", drivers.length === 2);

for (const driver of drivers) {
  // Antigravity's stdin stream-json transport is proven (tasks 1.1/1.3), so
  // the resolver returns available for the real driver and that same driver
  // exercises builder/resolver parity directly — no denial, and no
  // synthetic-id copy is needed to reach the invocation mechanics.
  if (driver.id === "antigravity") {
    const resolvedAgy = resolveAdapterTransport({driver, profile: null, request: {binary: PLACEHOLDER_BINARY, mode: "read", stdin: ""}});
    check("antigravity resolves available (stdin stream-json transport is proven)",
      resolvedAgy.available === true && resolvedAgy.reason === null && resolvedAgy.failure === null);
  }
  for (const request of [
    {binary: PLACEHOLDER_BINARY, cwd: "/tmp", scratchDir: null, model: "m1", reasoning: "high", mode: "write", stdin: "prompt-A"},
    {binary: PLACEHOLDER_BINARY, cwd: "/tmp", scratchDir: "/tmp/scratch", model: null, reasoning: null, mode: "read", stdin: ""},
    {binary: PLACEHOLDER_BINARY, cwd: "/workspace/repository", scratchDir: "/workspace/scratch", model: "m2", reasoning: null, mode: "scratch", trustedEnvelope: true, stdin: "prompt-B"}
  ]) {
    const label = `${driver.id}/${request.mode}${request.trustedEnvelope ? "+trusted" : ""}`;
    const direct = driver.buildInvocation({...request});
    const resolved = resolveAdapterTransport({driver, profile: null, request});
    // Parity is SEMANTIC: the resolver forwards the driver's own extra
    // invocation fields verbatim (agy's per-run settingsPath, which exists
    // precisely so the resolver cannot silently drop it), so both sides are
    // projected over the same keys the builder itself returned — only the
    // binary/args contract is shared by every driver.
    const directInvocation = {...direct, args: [...(direct.args || []).map(String)]};
    check(`${label}: resolver invocation === builder invocation`,
      resolved.available === true && canonicalJson(resolved.invocation) === canonicalJson(directInvocation));
    check(`${label}: resolver stdin === requested stdin verbatim`, resolved.stdin === (request.stdin ?? ""));
    check(`${label}: selections applied identically`,
      canonicalJson(driver.appliedSelections ? driver.appliedSelections(resolved.invocation) : {}) === canonicalJson(driver.appliedSelections ? driver.appliedSelections(direct) : {}));
  }
}

const read = name => fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

// The shared launch-plan builder wraps the resolved transport in the envelope
// (same code path as production missions).
check("launch-plan builder wraps transport.invocation inside the trusted envelope",
  (() => {
    const source = read("launch-plan.mjs");
    const t = source.indexOf("resolveAdapterTransport");
    const e = source.indexOf("buildExecutionEnvelope({");
    const b = source.indexOf("binary: transport.invocation.binary");
    return t >= 0 && e > t && b > e;
  })());

// Mission path shares the same authority: an early gate preserves
// fail-before-mutation ordering, and the shared launch-plan builder resolves
// the fully constructed mission request into the exact launched payload.
const autopilotSource = read("autopilot.mjs");
check("mission path gates availability before role-run artifacts exist",
  /missionTransportGate=resolveAdapterTransport\(\{driver:adapterDriver\(role\.adapter\)/.test(autopilotSource)
  && autopilotSource.indexOf("missionTransportGate=resolveAdapterTransport") < autopilotSource.indexOf("{dir,mission}=runDirFor(s,id,roleName)"));
check("mission invocation verification runs on the authorized argv",
  autopilotSource.indexOf("missionLaunchPlan=assembleAdapterLaunchPlan") > -1
  && autopilotSource.indexOf("missionLaunchPlan=assembleAdapterLaunchPlan") < autopilotSource.indexOf("verifyAgentInvocation(missionTransport.invocation.args,role,a)"));
// There is no provider gateway in the supported runtime any more (network
// isolation and the controlled-egress gateway were removed — see SKILL.md).
// executionEnvelope now comes directly from missionLaunchPlan.envelope,
// gated on `attemptEnvelope` (read-only roles only) rather than a
// provider-gateway-aware safety policy.
check("mission envelope comes from the single shared plan",
  autopilotSource.includes("const executionEnvelope=missionLaunchPlan.envelope;"));
check("mission direct launch falls back to the authorized binary/argv",
  /launchBinary=executionEnvelope\?\.available\?executionEnvelope\.binary:missionTransport\.invocation\.binary;/.test(autopilotSource)
  && /launchArgs=executionEnvelope\?\.available\?executionEnvelope\.args:missionTransport\.invocation\.args;/.test(autopilotSource));
check("mission feeds the authorized stdin to the child",
  /stdinData:missionTransport\.stdin/.test(autopilotSource));
const relaySource = read("subprocess-relay.mjs");
check("subprocess relay writes stdinData to child stdin",
  /child\.stdin\.write\(stdinData\)/.test(relaySource));
check("there is no provider-egress gateway in the mission launch path",
  !autopilotSource.includes("startProviderGateway") && !autopilotSource.includes("providerGateway"));
check("mission result records the authorized argv",
  /makeRelayResult\(\{roleName,role,a,p,args:missionTransport\.invocation\.args/.test(autopilotSource));

if (failures) {
  console.error(`${failures} transport-authority check(s) failed.`);
  process.exit(1);
}
console.log("shared transport authority tests passed");
