#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {preflightPrimaryModels} from "./preflight.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const agents = {
  opencode: {
    binary: "opencode",
    probe: ["--version"],
  },
};

// ── 1. Repairs for a bare primary and a bare fallback ─────────────────────────
{
  const catalog = [
    {id: "opencode/deepseek-v4.1-flash-free"},
    {id: "opencode/beam-free"},
  ];
  catalog.status = "reported";

  const config = {
    roles: {
      implementer: {
        adapter: "opencode",
        model: "deepseek-v4.1-flash-free",
        fallbacks: [
          {adapter: "opencode", model: "beam-free"},
        ],
      },
    },
  };

  const result = await preflightPrimaryModels({
    config,
    agents,
    discover: async () => catalog,
  });

  assert.equal(result.ok, true, "preflight should succeed when bare models can be repaired");
  assert.equal(result.problems.length, 0, "no problems expected when all bare models are uniquely resolved");
  assert.equal(result.repairs.length, 2, "repairs expected for bare primary and bare fallback");
  assert.deepEqual(result.repairs[0], {
    role: "implementer",
    adapter: "opencode",
    from: "deepseek-v4.1-flash-free",
    to: "opencode/deepseek-v4.1-flash-free",
  });
  assert.deepEqual(result.repairs[1], {
    role: "implementer",
    adapter: "opencode",
    from: "beam-free",
    to: "opencode/beam-free",
  });
  console.log("PASS: bare primary and bare fallback generate repairs");
}

// ── 2. Ambiguous bare model (two providers with same last segment) ────────────
{
  const catalog = [
    {id: "provider-a/deepseek-v4.1-flash-free"},
    {id: "provider-b/deepseek-v4.1-flash-free"},
  ];
  catalog.status = "reported";

  const config = {
    roles: {
      implementer: {
        adapter: "opencode",
        model: "deepseek-v4.1-flash-free",
      },
    },
  };

  const result = await preflightPrimaryModels({
    config,
    agents,
    discover: async () => catalog,
  });

  assert.equal(result.ok, false, "ambiguous bare model must fail preflight");
  assert.equal(result.repairs.length, 0, "ambiguous model must not generate any repairs");
  assert.equal(result.problems.length, 1, "ambiguous model must be reported as a problem");
  assert.equal(result.problems[0].role, "implementer");
  assert.equal(result.problems[0].adapter, "opencode");
  assert.equal(result.problems[0].model, "deepseek-v4.1-flash-free");
  console.log("PASS: ambiguous bare model results in problem and no repair");
}

// ── 2b. Ambiguous or unlisted fallback (ok stays true, unique bare fallback repaired) ──
{
  const catalog = [
    {id: "opencode/primary-model"},
    {id: "provider-a/ambiguous-model"},
    {id: "provider-b/ambiguous-model"},
    {id: "opencode/beam-free"},
  ];
  catalog.status = "reported";

  const config = {
    roles: {
      implementer: {
        adapter: "opencode",
        model: "opencode/primary-model",
        fallbacks: [
          {adapter: "opencode", model: "ambiguous-model"},
          {adapter: "opencode", model: "unlisted-model"},
          {adapter: "opencode", model: "opencode/unlisted-model"},
          {adapter: "opencode", model: "beam-free"},
        ],
      },
    },
  };

  const result = await preflightPrimaryModels({
    config,
    agents,
    discover: async () => catalog,
  });

  assert.equal(result.ok, true, "an ambiguous or unlisted opencode fallback gives no problem and ok stays true");
  assert.equal(result.problems.length, 0, "ambiguous or unlisted fallback gives no problem");
  assert.equal(result.repairs.length, 1, "bare fallback with a unique match is still repaired");
  assert.deepEqual(result.repairs[0], {
    role: "implementer",
    adapter: "opencode",
    from: "beam-free",
    to: "opencode/beam-free",
  });
  console.log("PASS: ambiguous or unlisted opencode fallback gives no problem and ok stays true; unique match is repaired");
}

// ── 3. Prefixed id → no repair ────────────────────────────────────────────────
{
  const catalog = [
    {id: "opencode/deepseek-v4.1-flash-free"},
    {id: "opencode/beam-free"},
  ];
  catalog.status = "reported";

  const config = {
    roles: {
      implementer: {
        adapter: "opencode",
        model: "opencode/deepseek-v4.1-flash-free",
        fallbacks: [
          {adapter: "opencode", model: "opencode/beam-free"},
        ],
      },
    },
  };

  const result = await preflightPrimaryModels({
    config,
    agents,
    discover: async () => catalog,
  });

  assert.equal(result.ok, true, "prefixed model should pass preflight");
  assert.equal(result.problems.length, 0, "no problems expected for valid prefixed models");
  assert.equal(result.repairs.length, 0, "no repairs expected for already prefixed models");
  console.log("PASS: prefixed models produce no repair");
}

// ── 4. OpenCode error event and stderr line with Invalid model reference ─────
{
  const driver = adapterDriver("opencode");
  const probe = {readPath: "", productionWritePath: "", outsideWritePath: ""};

  // 4a. Error event
  const errorEvent = {
    type: "error",
    error: {
      type: "unknown",
      message: "Invalid model reference: deepseek-v4.1-flash-free#medium",
    },
  };
  const obsEvent = driver.observe([errorEvent], probe);
  assert.ok(obsEvent.some(o => o.type === "invalid_model"), "error event must produce invalid_model observation");
  const failureEvent = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: "",
    startError: null,
    timedOut: false,
    driverless: false,
    evidence: obsEvent,
  });
  assert.equal(failureEvent?.class, "INVOCATION_MISMATCH");
  assert.equal(failureEvent?.domain, "adapter");
  assert.equal(failureEvent?.retryable, false);
  console.log("PASS: OpenCode error event classifies as INVOCATION_MISMATCH retryable:false");

  // 4b. Stderr engine-error line
  const stderrLine = `timestamp=2026-11-04T12:00:00.000Z level=ERROR run=8759b735 message="Invalid model reference: deepseek-v4.1-flash-free#high" role=server sessionID=ses_test`;
  const events = driver.decodeEvents("", stderrLine);
  const obsStderr = driver.observe(events, probe);
  assert.ok(obsStderr.some(o => o.type === "invalid_model"), "stderr engine-error line must produce invalid_model observation");
  const failureStderr = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: stderrLine,
    startError: null,
    timedOut: false,
    driverless: false,
    evidence: obsStderr,
  });
  assert.equal(failureStderr?.class, "INVOCATION_MISMATCH");
  assert.equal(failureStderr?.domain, "adapter");
  assert.equal(failureStderr?.retryable, false);
  console.log("PASS: OpenCode stderr engine-error classifies as INVOCATION_MISMATCH retryable:false");
}

// ── 5. Source check: autopilot.mjs applies repairs ─────────────────────────────
{
  const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  assert.match(autopilotSource, /primaryModels\.repairs/, "autopilot.mjs must inspect primaryModels.repairs");
  assert.match(autopilotSource, /\[preflight\] .* opencode model .* →/, "autopilot.mjs must log opencode model repair message");
  assert.match(autopilotSource, /fix it in \\?`ap config\\?`/, "autopilot.mjs must mention `ap config` in the preflight repair note");
  console.log("PASS: autopilot.mjs source check verifies repairs are applied and logged");
}

console.log("ALL CHECKS PASSED");
