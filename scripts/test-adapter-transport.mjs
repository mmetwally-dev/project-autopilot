#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {assembleAdapterLaunchPlan} from "./launch-plan.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-adapter-transport-"));
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

// A stub that leaves a marker when executed. If any spawn path launches it,
// the marker exists and the test fails — proving denial happens pre-spawn.
const stubPath = path.join(root, "stub.exe");
fs.writeFileSync(stubPath, "#!/bin/sh\ntouch marker\n");
try { fs.chmodSync(stubPath, 0o755); } catch {}

const peDriver = {
  id: "antigravity",
  contractVersion: 2,
  resolveBinary: () => stubPath,
  structuredTransport: "sentinel"
};
const nativeDriver = {
  id: "codex",
  contractVersion: 2,
  resolveBinary: binary => binary,
  buildInvocation: request => ({binary: request.binary, args: [...(request.args || [])]}),
  structuredTransport: "event-stream"
};
const nativeScript = path.join(root, "native-stub");
fs.writeFileSync(nativeScript, "#!/bin/sh\ntouch marker\n");
try { fs.chmodSync(nativeScript, 0o755); } catch {}
const nativeOkDriver = {
  id: "claude",
  contractVersion: 2,
  resolveBinary: () => nativeScript,
  buildInvocation: request => ({binary: request.binary, args: ["--version"]})
};

if (process.platform !== "win32") {
  // PE admission precedes every spawn on all three paths.
  const denied = resolveAdapterTransport({driver: peDriver, profile: null, request: {binary: stubPath}});
  check("PE binary is denied with windows_interop_not_contained", denied.available === false && denied.reason === "windows_interop_not_contained");
  check("denial maps to canonical policy failure PERMISSION_DENIED/non-retryable",
    denied.failure.class === "PERMISSION_DENIED" && denied.failure.domain === "policy" && denied.failure.retryable === false
    && denied.failure.schema === "autopilot-failure.v1");
  check("no marker: PE stub was never spawned for the direct probe", !fs.existsSync(path.join(root, "marker")));
}

// antigravity (agy) is admitted: its stdin stream-json transport is proven
// (tasks 1.1/1.3), so a native POSIX executable resolves available and the
// resolver makes the same argv passthrough it makes for every admitted
// adapter — no adapter id is transport-denied any more. The `models` request
// mirrors scripts/model-discovery.mjs's antigravity discovery call.
const antigravity = resolveAdapterTransport({
  driver: {...nativeDriver, id: "antigravity", resolveBinary: () => nativeScript},
  profile: null,
  request: {binary: nativeScript, args: ["models"]}
});
check("antigravity resolves available regardless of binary kind",
  antigravity.available === true && antigravity.reason === null && antigravity.failure === null
  && JSON.stringify(antigravity.invocation.args) === JSON.stringify(["models"]));
check("no marker: native antigravity stub was never spawned either", !fs.existsSync(path.join(root, "marker")));

// Resolver contract for admitted adapters.
const ok = resolveAdapterTransport({driver: nativeOkDriver, profile: null, request: {binary: nativeScript, stdin: "prompt text"}});
check("admitted adapter returns available:true with invocation and plain-text stdin",
  ok.available === true && Array.isArray(ok.invocation.args) && ok.invocation.binary && ok.stdin === "prompt text");
const invalid = resolveAdapterTransport({driver: null, request: {}});
check("resolver misuse is a stable non-retryable policy failure",
  invalid.available === false && invalid.reason === "adapter_transport_resolver_invalid" && invalid.failure.retryable === false);

// Legacy manual adapters (OpenCode, Claude, Cursor) have no v2 transport
// driver. They must remain usable through probing/manual workflows: the
// resolver admits them via binary admission alone and preserves the exact
// manifest invocation.
const manifestArgs = ["--version"];
const legacy = resolveAdapterTransport({driver: null, profile: null, request: {binary: nativeScript, args: manifestArgs}});
check("legacy adapter without driver is admitted with exact manifest args",
  legacy.available === true && Array.isArray(legacy.invocation.args)
  && JSON.stringify(legacy.invocation.args) === JSON.stringify(manifestArgs) && Boolean(legacy.invocation.binary));

// A denied PE is denied identically on the legacy path — no driver shortcut.
if (process.platform !== "win32") {
  const legacyDenied = resolveAdapterTransport({driver: null, request: {binary: stubPath, args: manifestArgs}});
  check("legacy path denies PE binaries with windows_interop_not_contained",
    legacyDenied.available === false && legacyDenied.reason === "windows_interop_not_contained");
  check("no marker: legacy PE stub was never spawned", !fs.existsSync(path.join(root, "marker")));
}

// Static regression guard: the mission path gates transport before its first
// spawn/mutation.
const read = name => fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const autopilotSource = read("autopilot.mjs");
check("mission path gates transport before creating role-run artifacts",
  autopilotSource.indexOf("missionTransport") >= 0
  && autopilotSource.indexOf("missionTransport") < autopilotSource.indexOf("{dir,mission}=runDirFor(s,id,roleName)"));

// Launch-plan equivalence (moved from the removed
// test-trusted-containment-attribution.mjs): the shared launch-plan builder
// resolves to exactly the resolver's invocation and fails closed on envelope errors.
{
  const fakeDriver = {
    buildInvocation(request) { return {binary: request.binary, args: ["--mode", request.mode, "--model", request.model]}; },
    decodeEvents() { return []; }
  };
  const launchRequest = {binary: "/bin/echo", cwd: "/repo", scratchDir: "/scratch", model: "prov/model-x", reasoning: "high", mode: "scratch", trustedEnvelope: true, stdin: "brief"};
  const directTransport = resolveAdapterTransport({driver: fakeDriver, profile: "resolved-profile", request: launchRequest});
  const planArgs = {driver: fakeDriver, adapterProviderProfile: "resolved-profile", launchRequest, config: {}, repo: "/repo", scratchDir: "/scratch", readOnly: true};
  const plan = assembleAdapterLaunchPlan(planArgs);
  check("launch plan invocation === resolver invocation for identical semantic role",
    plan.available && JSON.stringify(plan.invocation) === JSON.stringify(directTransport.invocation));
  check("launch plan preserves stdin verbatim", plan.stdin === "brief");
  const deniedPlan = assembleAdapterLaunchPlan({...planArgs, runtimeFiles: ["/nonexistent/runtime-helper"]});
  check("launch plan surfaces precise envelope-stage failure (fail closed)",
    !deniedPlan.available && deniedPlan.stage === "envelope" && deniedPlan.reason === "adapter_runtime_file_missing");
}

// Encoding boundaries: supported adapters keep exact stdin bytes through the resolver.
for (const prompt of ["", "line1\nline2\n", "\xC3\xA9\xE2\x82\xAC unicode \u0645\u0631\u062D\u0628\u0627", "  padded  ", 'echo AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}']) {
  const result = resolveAdapterTransport({driver: nativeOkDriver, request: {binary: nativeScript, stdin: prompt}});
  check(`stdin preserved verbatim (${JSON.stringify(prompt).slice(0, 24)}...)`, result.available && result.stdin === prompt);
}

fs.rmSync(root, {recursive: true, force: true});
if (failures) {
  console.error(`${failures} adapter transport check(s) failed.`);
  process.exit(1);
}
console.log("shared adapter transport resolver tests passed");
