#!/usr/bin/env node
// Mission 093 Part 1 task 2.2: wiring test for model recording.
// initRun carries configuredModel with null resolvedModel/modelMismatch;
// recordRunModel persists the stream-resolved model on first report (and the
// mismatch flag when it differs from the configured/active model); the
// legacy `model` field and run-history rendering stay untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRun, updateRunModel } from "./run-observability.mjs";
import { runModelPatch, recordRunModel } from "./adapter-drivers.mjs";
import { agyRunModelPatch } from "./agy-events.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};
const readStatus = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const historySource = fs.readFileSync(new URL("./run-history.mjs", import.meta.url), "utf8");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "093-model-wire-"));

// ── 1. Launch: configuredModel persisted, resolved null/null, no `model` ──
const dirLaunch = path.join(root, "launch");
initRun(dirLaunch, { role: "implementer", runId: "run-1", configuredModel: "claude-sonnet-4-5", resolvedModel: null, modelMismatch: null });
{
  const st = readStatus(dirLaunch);
  check("launch: configuredModel persisted", st.configuredModel === "claude-sonnet-4-5", st.configuredModel);
  check("launch: resolvedModel null before resolution", st.resolvedModel === null, st.resolvedModel);
  check("launch: modelMismatch null before resolution", st.modelMismatch === null, st.modelMismatch);
  check("launch: legacy model field untouched (absent)", !("model" in st), Object.keys(st));
}

// ── 2. Before first stream report: no persist, null/null stands ──────────
{
  const before = readStatus(dirLaunch);
  const patch = recordRunModel(dirLaunch, "claude", [{ type: "system", subtype: "init" }], "claude-sonnet-4-5");
  check("pre-resolution: patch resolvedModel null", patch.resolvedModel === null, patch);
  check("pre-resolution: patch modelMismatch null", patch.modelMismatch === null, patch);
  check("pre-resolution: patch echoes configuredModel", patch.configuredModel === "claude-sonnet-4-5", patch);
  const after = readStatus(dirLaunch);
  check("pre-resolution: status.json untouched (null/null stands)", after.resolvedModel === null && after.modelMismatch === null, after);
  check("pre-resolution: configuredModel not clobbered", after.configuredModel === before.configuredModel, after);
}

// ── 3. First stream report: matching model persists, mismatch false ──────
{
  const events = [{ type: "assistant", message: { id: "m1", model: "claude-sonnet-4-5" } }];
  const patch = recordRunModel(dirLaunch, "claude", events, "claude-sonnet-4-5");
  check("match: patch resolves", patch.resolvedModel === "claude-sonnet-4-5", patch);
  check("match: patch mismatch false", patch.modelMismatch === false, patch);
  const st = readStatus(dirLaunch);
  check("match: status resolvedModel persisted", st.resolvedModel === "claude-sonnet-4-5", st);
  check("match: status modelMismatch persisted", st.modelMismatch === false, st);
  check("match: status configuredModel preserved", st.configuredModel === "claude-sonnet-4-5", st);
  check("match: legacy model field still untouched", !("model" in st), Object.keys(st));
}

// ── 4. Differing resolved model: mismatch true persisted ─────────────────
const dirMismatch = path.join(root, "mismatch");
initRun(dirMismatch, { role: "implementer", runId: "run-2", configuredModel: "claude-sonnet-4-5", resolvedModel: null, modelMismatch: null });
{
  const events = [
    { type: "assistant", message: { id: "m1", model: "claude-sonnet-4-5" } },
    { type: "result", subtype: "success", model: "claude-opus-4-6", result: "done" },
  ];
  const patch = recordRunModel(dirMismatch, "claude", events, "claude-sonnet-4-5");
  check("mismatch: terminal model wins", patch.resolvedModel === "claude-opus-4-6", patch);
  check("mismatch: patch flags true", patch.modelMismatch === true, patch);
  const st = readStatus(dirMismatch);
  check("mismatch: status resolvedModel persisted", st.resolvedModel === "claude-opus-4-6", st);
  check("mismatch: status modelMismatch persisted true", st.modelMismatch === true, st);
  check("mismatch: configuredModel preserved", st.configuredModel === "claude-sonnet-4-5", st);
}

// ── 5. CLI-default launch (configured null): resolves without mismatch ────
const dirDefault = path.join(root, "default");
initRun(dirDefault, { role: "implementer", runId: "run-3", configuredModel: null, resolvedModel: null, modelMismatch: null });
{
  const st0 = readStatus(dirDefault);
  check("default: configuredModel null when CLI chose default", st0.configuredModel === null, st0);
  const patch = recordRunModel(dirDefault, "opencode", [{ type: "step_start", modelID: "muse-spark-1.3" }], null);
  check("default: opencode modelID resolves", patch.resolvedModel === "muse-spark-1.3", patch);
  check("default: no configured model is never a mismatch", patch.modelMismatch === false, patch);
  const st = readStatus(dirDefault);
  check("default: status persists resolved model", st.resolvedModel === "muse-spark-1.3" && st.modelMismatch === false, st);
}

// ── 6. agy hook echoes configured + resolves init model ──────────────────
{
  const patch = agyRunModelPatch(
    [{ event: "init", init: { model: "gemini-3-flash" } }],
    "gemini-3-flash",
  );
  check("agy: patch shape", patch.configuredModel === "gemini-3-flash" && patch.resolvedModel === "gemini-3-flash" && patch.modelMismatch === false, patch);
  const routed = runModelPatch("antigravity", [{ event: "init", init: { model: "gemini-3-pro" } }], "gemini-3-flash");
  check("agy: runModelPatch routes to agy resolver with mismatch", routed.resolvedModel === "gemini-3-pro" && routed.modelMismatch === true, routed);
}

// ── 7. updateRunModel writes only model keys, never legacy `model` ────────
{
  const ok = updateRunModel(dirDefault, { resolvedModel: "x", model: "LEGACY-MUST-NOT-LAND", unknown: 1 });
  const st = readStatus(dirDefault);
  check("updateRunModel: returns true for a model patch", ok === true, ok);
  check("updateRunModel: ignores legacy model key", !("model" in st), Object.keys(st));
  check("updateRunModel: ignores unknown keys", !("unknown" in st), Object.keys(st));
  check("updateRunModel: empty patch is a no-op", updateRunModel(dirDefault, {}) === false, null);
}

// ── 8. Relay wiring pins (autopilot.mjs source) ───────────────────────────
check("wire: relay seeds configuredModel at launch",
  /const configuredModel=\(typeof role\.model==="string"&&role\.model!==""\?role\.model:null\)/.test(autopilotSource));
check("wire: stream tick records the resolved model",
  /recordRunModel\(dir,role\.adapter,capEvents,configuredModel\)/.test(autopilotSource));
check("wire: final stream resolves modelResolution onto the result",
  /modelResolution=runModelPatch\(role\.adapter,events,configuredModel\)/.test(autopilotSource)
  && /modelResolution[^}]*\}\)/.test(autopilotSource));
check("wire: makeRelayResult carries the three model fields",
  /configuredModel:\(typeof role\?\.model==="string"&&role\.model!==""\?role\.model:null\)/.test(autopilotSource)
  && /resolvedModel:modelResolution\?\.resolvedModel\?\?null/.test(autopilotSource)
  && /modelMismatch:modelResolution\?\.modelMismatch\?\?null/.test(autopilotSource));
check("wire: legacy result model field untouched",
  /^\s*model:role\.model\|\|null,$/m.test(autopilotSource));
check("wire: run-history rendering has no model fields",
  !/configuredModel|resolvedModel|modelMismatch/.test(historySource));

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.error(`${failures.length} model-wire check(s) failed.`); process.exit(1); }
console.log("All model-wire checks passed.");
