#!/usr/bin/env node
// Mission 001 task 20: shared-cache adapter-gating proof.
//
// Static: the non-opencode path in scripts/autopilot.mjs never calls
// ensureOpenCodeCacheSeeded() and never produces a non-null task-12
// parameter; the task-14 production call site never passes the test-only
// overrides (versionTagOverride / installCommandOverride).
// Dynamic: a real sandboxed (bwrap) run assembled for a non-OpenCode role
// — opencodeCacheDir explicitly null, exactly like every production
// non-opencode caller — asserts the resulting bwrapArgs contain no
// --ro-bind at /autopilot/opencode-cache and the sandboxed process
// environment contains neither task-13 cache env var (not present,
// not empty). A contrast control with a real cache dir proves the harness
// can detect the mount (no vacuous pass).
//
// No model calls, no auth needed. Fails closed on Linux/WSL2 when bwrap
// is missing; skips only on native Windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assembleAdapterLaunchPlan} from "./launch-plan.mjs";
import {mapEnvironmentIntoEnvelope} from "./execution-envelope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("test-shared-cache-adapter-gating: SKIP — requires Linux/WSL2 bubblewrap.");
  process.exit(0);
}

const norm = src => String(src).replace(/\s+/g, "");
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
const launchPlanSource = fs.readFileSync(path.join(here, "launch-plan.mjs"), "utf8");
const envelopeSource = fs.readFileSync(path.join(here, "execution-envelope.mjs"), "utf8");
const cacheSource = fs.readFileSync(path.join(here, "opencode-cache.mjs"), "utf8");
const normAuto = norm(autopilotSource);

// ---- Static: non-opencode path never seeds, never passes the parameter --
{
  const gate = 'if(role.adapter==="opencode")';
  const gateIdx = normAuto.indexOf(gate);
  check("static: opencode gate exists in autopilot.mjs", gateIdx >= 0);
  // Backlog #1: the production call now passes {requiredModels} so the
  // shared catalog refreshes when a read-only role needs a missing model.
  // Match any argument list, but never a test-only override (those are
  // asserted absent from autopilot.mjs below).
  const seedCalls = [...normAuto.matchAll(/ensureOpenCodeCacheSeeded\(/g)].map(m => m.index);
  check("static: exactly one production seeder call (the opencode-gated one)", seedCalls.length === 1, `found=${seedCalls.length}`);
  for (const idx of seedCalls) {
    const window = normAuto.slice(Math.max(0, idx - 400), idx);
    check("static: seeder call is inside the opencode-gated block (non-opencode roles never call it)",
      window.includes(gate), `no '${gate}' within 400 chars before call at ${idx}`);
    check("static: production seeder call passes only requiredModels (no test-only overrides)",
      normAuto.slice(idx, idx + 80).startsWith("ensureOpenCodeCacheSeeded({requiredModels:openCodeModelsForRole(role)})"),
      `call=${normAuto.slice(idx, idx + 80)}`);
  }
  const assignIdx = normAuto.indexOf("snapshotDir=fs.realpathSync");
  check("static: cache-dir assignment exists once", assignIdx >= 0);
  check("static: non-null cache dir produced only under the opencode gate",
    assignIdx >= 0 && normAuto.slice(Math.max(0, assignIdx - 800), assignIdx).includes(gate));
  check("static: cache-mount variable defaults to null (every non-opencode caller passes null)",
    normAuto.includes("letsharedCacheMount=null"));
  check("static: envelope handoff uses the gated variable",
    normAuto.includes("sharedCacheMount,sharedCacheCompanionMount,extraEnv:sharedCacheExtraEnv"));
  check("static: launch-plan.mjs never calls the seeder (only forwards the parameter)",
    !launchPlanSource.includes("ensureOpenCodeCacheSeeded("));
}

// ---- Static: production call site never passes test-only overrides -------
{
  check("static: autopilot.mjs never passes versionTagOverride", !autopilotSource.includes("versionTagOverride"));
  check("static: autopilot.mjs never passes installCommandOverride", !autopilotSource.includes("installCommandOverride"));
  check("static: launch-plan.mjs never passes versionTagOverride", !launchPlanSource.includes("versionTagOverride"));
  check("static: launch-plan.mjs never passes installCommandOverride", !launchPlanSource.includes("installCommandOverride"));
  // Non-vacuousness: the parameters really exist in the implementation —
  // production just never supplies them.
  check("static: overrides exist as seeder parameters (check is not vacuous)",
    cacheSource.includes("versionTagOverride") && cacheSource.includes("installCommandOverride"));
  check("static: envelope defaults sharedCacheMount to null (omit => no mount)",
    norm(envelopeSource).includes("sharedCacheMount=null"));
  check("static: execution-envelope.mjs never references opencode by name (adapter-agnostic mount/env plumbing)",
    !envelopeSource.includes("opencode"));
}

// ---- Dynamic: real non-OpenCode sandboxed role -----------------------------
const PROBE_SOURCE = `
import fs from "node:fs";
const results = {};
results.env = {OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH ?? null, OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? null};
try { fs.readFileSync("/autopilot/opencode-cache/xdg-cache/opencode/models.json"); results.mountRead = "SUCCEEDED"; }
catch (e) { results.mountRead = "ERR:" + (e.code || e.message); }
console.log("PROBE_RESULT=" + JSON.stringify(results));
`;
function assemble({repo, scratchDir, opencodeCacheDir}) {
  // Mirrors the real production call site (autopilot.mjs task 14): the
  // generic {host,sandbox} mount descriptors + matching env vars are built
  // here, by the caller — execution-envelope.mjs itself never sees
  // "opencode" anywhere in its source.
  return assembleAdapterLaunchPlan({
    driver: null,
    adapterProviderProfile: null,
    launchRequest: {binary: process.execPath, args: ["--input-type=module", "-e", PROBE_SOURCE], stdin: ""},
    config: {}, repo, scratchDir, readOnly: true, permissionFiles: [], runtimeFiles: [],
    sharedCacheMount: opencodeCacheDir ? {host: opencodeCacheDir, sandbox: "/autopilot/opencode-cache"} : null,
    extraEnv: opencodeCacheDir ? {
      OPENCODE_MODELS_PATH: "/autopilot/opencode-cache/xdg-cache/opencode/models.json",
      OPENCODE_DISABLE_MODELS_FETCH: "1"
    } : {}
  });
}
function roBindTargets(args) {
  const targets = [];
  for (let i = 0; i < args.length - 2; i += 1) {
    if (args[i] === "--ro-bind") targets.push({source: args[i + 1], target: args[i + 2]});
  }
  return targets;
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cache-gating-repo-"));
const scratchNull = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cache-gating-scratch-null-"));
const scratchWith = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cache-gating-scratch-with-"));
const fixtureCache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-cache-gating-fixture-")));
fs.writeFileSync(path.join(fixtureCache, "MARKER.txt"), "fixture-cache-marker");
try {
  // Production non-opencode shape: opencodeCacheDir explicitly null.
  const planNull = assemble({repo, scratchDir: scratchNull, opencodeCacheDir: null});
  check("dynamic: non-opencode launch plan is available", planNull.available === true, planNull.reason || planNull.detail);
  if (!planNull.available) { console.error("FAIL closed: envelope unavailable on Linux/WSL2."); process.exit(1); }
  const argsNull = planNull.envelope.args;
  check("dynamic: bwrapArgs contain no --ro-bind at /autopilot/opencode-cache",
    !roBindTargets(argsNull).some(b => b.target === "/autopilot/opencode-cache"),
    JSON.stringify(roBindTargets(argsNull).map(b => b.target)));
  // Bind-position scan only: the inline `-e` probe script legitimately
  // names the path as a string (it asserts the mount is UNREADABLE), so a
  // whole-args substring scan would false-positive on the payload itself.
  // What matters is no bind SOURCE or TARGET touches the sandbox path.
  check("dynamic: no bind source/target touches the sandbox cache path",
    !argsNull.some((a, i) => (argsNull[i - 1] === "--ro-bind" || argsNull[i - 1] === "--bind")
      && String(a).startsWith("/autopilot/opencode-cache")),
    JSON.stringify(roBindTargets(argsNull)));
  const baseEnv = {...process.env};
  delete baseEnv.OPENCODE_MODELS_PATH;
  delete baseEnv.OPENCODE_DISABLE_MODELS_FETCH;
  const childEnvNull = mapEnvironmentIntoEnvelope(baseEnv, planNull.envelope, repo, scratchNull);
  check("dynamic: mapped env has no OPENCODE_MODELS_PATH (not present, not empty)",
    !("OPENCODE_MODELS_PATH" in childEnvNull) && (childEnvNull.OPENCODE_MODELS_PATH ?? null) === null,
    `value=${JSON.stringify(childEnvNull.OPENCODE_MODELS_PATH)}`);
  check("dynamic: mapped env has no OPENCODE_DISABLE_MODELS_FETCH (not present, not empty)",
    !("OPENCODE_DISABLE_MODELS_FETCH" in childEnvNull) && (childEnvNull.OPENCODE_DISABLE_MODELS_FETCH ?? null) === null,
    `value=${JSON.stringify(childEnvNull.OPENCODE_DISABLE_MODELS_FETCH)}`);
  const rNull = spawnSync(planNull.envelope.binary, planNull.envelope.args, {encoding: "utf8", shell: false, timeout: 30000, env: childEnvNull, cwd: os.tmpdir()});
  check("dynamic: sandboxed probe exits 0", rNull.status === 0, rNull.stderr);
  const lineNull = String(rNull.stdout || "").split("\n").filter(l => l.startsWith("PROBE_RESULT=")).at(-1);
  let resNull = null;
  try { resNull = JSON.parse(lineNull.slice("PROBE_RESULT=".length)); } catch {}
  check("dynamic: sandboxed env has no OPENCODE_MODELS_PATH", resNull?.env?.OPENCODE_MODELS_PATH === null, JSON.stringify(resNull?.env));
  check("dynamic: sandboxed env has no OPENCODE_DISABLE_MODELS_FETCH", resNull?.env?.OPENCODE_DISABLE_MODELS_FETCH === null, JSON.stringify(resNull?.env));
  check("dynamic: sandbox cannot see /autopilot/opencode-cache", typeof resNull?.mountRead === "string" && resNull.mountRead.startsWith("ERR:"), resNull?.mountRead);

  // Contrast control: the same harness WITH a cache dir must detect it.
  const planWith = assemble({repo, scratchDir: scratchWith, opencodeCacheDir: fixtureCache});
  check("control: launch plan with cache dir is available", planWith.available === true, planWith.reason || planWith.detail);
  if (planWith.available) {
    const binds = roBindTargets(planWith.envelope.args);
    check("control: bwrapArgs DO contain the --ro-bind at /autopilot/opencode-cache",
      binds.some(b => b.target === "/autopilot/opencode-cache" && b.source === fixtureCache), JSON.stringify(binds.map(b => b.target)));
    const childEnvWith = mapEnvironmentIntoEnvelope(baseEnv, planWith.envelope, repo, scratchWith);
    check("control: mapped env HAS OPENCODE_MODELS_PATH at the mount",
      childEnvWith.OPENCODE_MODELS_PATH === "/autopilot/opencode-cache/xdg-cache/opencode/models.json", childEnvWith.OPENCODE_MODELS_PATH);
    check("control: mapped env HAS OPENCODE_DISABLE_MODELS_FETCH=1",
      childEnvWith.OPENCODE_DISABLE_MODELS_FETCH === "1", childEnvWith.OPENCODE_DISABLE_MODELS_FETCH);
  }
} finally {
  for (const dir of [repo, scratchNull, scratchWith, fixtureCache]) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
  }
}

if (failures) {
  console.error(`${failures} shared-cache adapter-gating check(s) failed.`);
  process.exit(1);
}
console.log("test-shared-cache-adapter-gating: ALL CHECKS PASSED");
