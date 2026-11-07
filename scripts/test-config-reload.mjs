#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffConfigPaths, applyConfigReload } from "./config-reload.mjs";
import { reloadConfigIfChanged, applyPreflightRepairs, setLiveConfigRepairsForTests } from "./autopilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// (a) diffConfigPaths unit cases
// ============================================================================

// 1. Changed nested value
{
  const oldObj = { roles: { implementer: { model: "gemini-4-argon-medium" } } };
  const newObj = { roles: { implementer: { model: "gemini-3.8-flash-medium" } } };
  const diff = diffConfigPaths(oldObj, newObj);
  assert.deepEqual(diff, [
    "roles.implementer.model gemini-4-argon-medium → gemini-3.8-flash-medium"
  ]);
  console.log("PASS diffConfigPaths: changed nested value");
}

// 2. Added key
{
  const oldObj = { a: 1 };
  const newObj = { a: 1, b: "hello" };
  const diff = diffConfigPaths(oldObj, newObj);
  assert.deepEqual(diff, ["b (none) → hello"]);

  const nestedOld = {};
  const nestedNew = { gates: { lint: "npm run lint" } };
  const nestedDiff = diffConfigPaths(nestedOld, nestedNew);
  assert.deepEqual(nestedDiff, ["gates.lint (none) → npm run lint"]);
  console.log("PASS diffConfigPaths: added key");
}

// 3. Removed key
{
  const oldObj = { a: 1, b: "hello" };
  const newObj = { a: 1 };
  const diff = diffConfigPaths(oldObj, newObj);
  assert.deepEqual(diff, ["b hello → (removed)"]);
  console.log("PASS diffConfigPaths: removed key");
}

// 4. Array element change
{
  const oldObj = {
    roles: {
      implementer: {
        fallbacks: [
          { model: "gemini-3.8-flash-medium" },
          { model: "gemini-4-argon-medium" }
        ]
      }
    }
  };
  const newObj = {
    roles: {
      implementer: {
        fallbacks: [
          { model: "gemini-3.8-flash-medium" },
          { model: "gemini-3.8-flash-medium" }
        ]
      }
    }
  };
  const diff = diffConfigPaths(oldObj, newObj);
  assert.deepEqual(diff, [
    "roles.implementer.fallbacks[1].model gemini-4-argon-medium → gemini-3.8-flash-medium"
  ]);

  const primOld = { items: [1, 2, 3] };
  const primNew = { items: [1, 99, 3] };
  assert.deepEqual(diffConfigPaths(primOld, primNew), ["items[1] 2 → 99"]);
  console.log("PASS diffConfigPaths: array element change");
}

// 5. Identical → []
{
  const obj1 = {
    roles: { implementer: { model: "foo", fallbacks: [{ adapter: "bar" }] } },
    gates: { test: "npm test" },
    retries: [1, 2]
  };
  const obj2 = {
    roles: { implementer: { model: "foo", fallbacks: [{ adapter: "bar" }] } },
    gates: { test: "npm test" },
    retries: [1, 2]
  };
  assert.deepEqual(diffConfigPaths(obj1, obj2), []);
  console.log("PASS diffConfigPaths: identical → []");
}

// 6. Truncation with maxLines
{
  const oldObj = {};
  const newObj = {};
  for (let i = 0; i < 25; i++) newObj[`k${i}`] = i;
  const diff = diffConfigPaths(oldObj, newObj, { maxLines: 5 });
  assert.equal(diff.length, 6);
  assert.ok(diff[5].includes("20 more"));
  console.log("PASS diffConfigPaths: maxLines truncation");
}

// ============================================================================
// (b) Source checks on autopilot.mjs
// ============================================================================
{
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

  // runRelay calls reloadConfigIfChanged before it reads c.roles
  const runRelayIdx = src.indexOf("async function runRelay(");
  assert.ok(runRelayIdx !== -1, "runRelay function definition must exist");
  const runRelayBody = src.slice(runRelayIdx, runRelayIdx + 2000);
  const reloadCallIdx = runRelayBody.indexOf("reloadConfigIfChanged(c)");
  const rolesReadIdx = runRelayBody.indexOf("c.roles");
  assert.ok(reloadCallIdx !== -1, "runRelay must call reloadConfigIfChanged(c)");
  assert.ok(rolesReadIdx !== -1, "runRelay must read c.roles");
  assert.ok(
    reloadCallIdx < rolesReadIdx,
    "runRelay must call reloadConfigIfChanged(c) before reading c.roles"
  );
  console.log("PASS source: runRelay calls reloadConfigIfChanged before reading c.roles");

  // main sets baseline mtime after cfg()
  const mainIdx = src.indexOf("async function main()");
  assert.ok(mainIdx !== -1, "main function definition must exist");
  const mainBody = src.slice(mainIdx);
  const cfgMatch = /const\s+c\s*=\s*cfg\(\);[\s\S]{0,100}liveConfigMtimeMs\s*=/.test(mainBody);
  assert.ok(cfgMatch, "main must set baseline liveConfigMtimeMs after cfg()");
  console.log("PASS source: main sets baseline mtime after cfg()");

  // reloadConfigIfChanged never calls die( and uses persist:false and updates c in place
  const reloadFuncIdx = src.indexOf("function reloadConfigIfChanged(");
  assert.ok(reloadFuncIdx !== -1, "reloadConfigIfChanged function must exist");
  const reloadBody = src.slice(reloadFuncIdx, reloadFuncIdx + 2000);
  assert.ok(!reloadBody.includes("die("), "reloadConfigIfChanged must never call die(");
  assert.ok(/persist:\s*false/.test(reloadBody), "reloadConfigIfChanged must use persist:false");
  assert.ok(
    reloadBody.includes("applyConfigReload(c,") || reloadBody.includes("applyConfigReload(c ,"),
    "reloadConfigIfChanged must update c in place"
  );
  console.log("PASS source: reloadConfigIfChanged never calls die, uses persist:false, updates c in place");

  // reloadConfigIfChanged calls applyPreflightRepairs after applyConfigReload
  const applyReloadIdx = reloadBody.indexOf("applyConfigReload(");
  const applyPreflightIdx = reloadBody.indexOf("applyPreflightRepairs(");
  assert.ok(applyReloadIdx !== -1, "reloadConfigIfChanged must call applyConfigReload");
  assert.ok(applyPreflightIdx !== -1, "reloadConfigIfChanged must call applyPreflightRepairs");
  assert.ok(
    applyReloadIdx < applyPreflightIdx,
    "reloadConfigIfChanged must call applyPreflightRepairs after applyConfigReload"
  );
  console.log("PASS source: reloadConfigIfChanged calls applyPreflightRepairs after applyConfigReload");
}

// ============================================================================
// (c) Core reload helper and in-place reload tests
// ============================================================================
{
  const c = {
    roles: { implementer: { model: "gemini-4-argon-medium" } },
    oldProperty: "remove_me"
  };
  const ref = c;
  const nextConfig = {
    roles: { implementer: { model: "gemini-3.8-flash-medium" } },
    newProperty: "keep_me"
  };

  const diff = applyConfigReload(c, nextConfig);
  assert.equal(c, ref, "Object identity of c must be preserved");
  assert.equal(c.oldProperty, undefined, "Missing keys must be deleted");
  assert.equal(c.newProperty, "keep_me", "New keys must be assigned");
  assert.equal(c.roles.implementer.model, "gemini-3.8-flash-medium", "Nested values updated");
  assert.ok(diff.length > 0, "Diff returned");
  console.log("PASS applyConfigReload: in-place update and object identity preserved");
}

// Temp repo test exercising reloadConfigIfChanged
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cfg-reload-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    const validRoles = {
      planner: { adapter: "opencode" },
      plan_reviewer: { adapter: "opencode" },
      implementer: { adapter: "opencode", model: "gemini-4-argon-medium" },
      code_reviewer: { adapter: "opencode" },
      verifier: { adapter: "opencode" }
    };
    const initialConfig = {
      schema_version: 4,
      project: { name: "test-proj", planning_framework: "standalone" },
      roles: validRoles,
      tests: {
        gate_commands: ["npm test"]
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

    const { loadAndMigrateConfig } = await import("./config-migration.mjs");
    const liveC = loadAndMigrateConfig(configPath, { persist: false }).config;
    const liveRef = liveC;

    // Sleep briefly or touch to ensure mtime differs
    const nextTime = new Date(Date.now() + 2000);
    const updatedConfig = {
      schema_version: 4,
      project: { name: "test-proj", planning_framework: "standalone" },
      roles: {
        ...validRoles,
        implementer: { adapter: "opencode", model: "gemini-3.8-flash-medium" }
      },
      tests: {
        gate_commands: ["npm run test:all"]
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
    fs.utimesSync(configPath, nextTime, nextTime);

    // Capture stdout
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      reloadConfigIfChanged(liveC, configPath);
    } finally {
      console.log = originalLog;
    }

    assert.equal(liveC, liveRef, "live config identity preserved");
    assert.equal(liveC.roles.implementer.model, "gemini-3.8-flash-medium", "live config model updated");
    assert.deepEqual(liveC.gates.commands, ["npm run test:all"], "gates.commands updated");

    const logOutput = logs.join("\n");
    assert.ok(logOutput.includes("config reloaded:"), "log must include 'config reloaded:'");
    assert.ok(
      logOutput.includes("roles.implementer.model gemini-4-argon-medium → gemini-3.8-flash-medium"),
      "log must show model diff"
    );
    assert.ok(
      logOutput.includes("note: gate/test command changes apply from the next gate run"),
      "log must show gate/test note when gates changed"
    );
    console.log("PASS reloadConfigIfChanged: valid config reloaded in place with diff and gate note");

    // Invalid config test: reload skipped and old config kept
    const invalidTime = new Date(Date.now() + 4000);
    // Unknown adapter
    const invalidConfig = {
      schema_version: 4,
      project: { name: "test-proj", planning_framework: "standalone" },
      roles: {
        ...validRoles,
        implementer: { adapter: "nonexistent_adapter_xyz" }
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2));
    fs.utimesSync(configPath, invalidTime, invalidTime);

    const originalWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      reloadConfigIfChanged(liveC, configPath);
      // Call a second time with the same mtime to verify it only prints once per mtime
      reloadConfigIfChanged(liveC, configPath);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(liveC.roles.implementer.model, "gemini-3.8-flash-medium", "old running config kept");
    assert.equal(warns.length, 1, "warning printed exactly once per mtime");
    assert.ok(
      warns[0].includes("config reload skipped:") && warns[0].includes("keeping the running config"),
      "warning message matches expected format"
    );
    console.log("PASS reloadConfigIfChanged: invalid config skipped without dying, warns once per mtime");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Preflight repair preservation across reload (backlog #4)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cfg-reload-repair-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    const validRoles = {
      planner: { adapter: "opencode" },
      plan_reviewer: { adapter: "opencode" },
      implementer: {
        adapter: "opencode",
        model: "deepseek-v4.1-flash-free",
        fallbacks: [
          { adapter: "opencode", model: "beam-free" }
        ]
      },
      code_reviewer: { adapter: "opencode" },
      verifier: { adapter: "opencode" }
    };
    const initialConfig = {
      schema_version: 4,
      project: { name: "test-proj", planning_framework: "standalone" },
      roles: validRoles,
      tests: {
        gate_commands: ["npm test"]
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

    const { loadAndMigrateConfig } = await import("./config-migration.mjs");
    const liveC = loadAndMigrateConfig(configPath, { persist: false }).config;

    const repairs = [
      {
        role: "implementer",
        adapter: "opencode",
        from: "deepseek-v4.1-flash-free",
        to: "opencode/deepseek-v4.1-flash-free"
      },
      {
        role: "implementer",
        adapter: "opencode",
        from: "beam-free",
        to: "opencode/beam-free"
      }
    ];
    setLiveConfigRepairsForTests(repairs);
    applyPreflightRepairs(liveC, repairs);

    assert.equal(liveC.roles.implementer.model, "opencode/deepseek-v4.1-flash-free");
    assert.equal(liveC.roles.implementer.fallbacks[0].model, "opencode/beam-free");

    // Modify file: change tests/gates, but keep bare model ids in config file
    const nextTime = new Date(Date.now() + 2000);
    const updatedConfig = {
      schema_version: 4,
      project: { name: "test-proj", planning_framework: "standalone" },
      roles: validRoles,
      tests: {
        gate_commands: ["npm run test:all"]
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
    fs.utimesSync(configPath, nextTime, nextTime);

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      reloadConfigIfChanged(liveC, configPath);
    } finally {
      console.log = origLog;
    }

    // A reload whose file still has the bare id keeps the repaired id in c
    assert.equal(
      liveC.roles.implementer.model,
      "opencode/deepseek-v4.1-flash-free",
      "bare primary model id in file must keep repaired id in c"
    );
    assert.equal(
      liveC.roles.implementer.fallbacks[0].model,
      "opencode/beam-free",
      "bare fallback model id in file must keep repaired id in c"
    );

    const logOutput = logs.join("\n");
    // Verify diff lines only reflect non-repair changes
    assert.ok(logOutput.includes("config reloaded:"), "log must show config reloaded");
    assert.ok(logOutput.includes("gates.commands"), "log must show gate command diff");
    assert.ok(!logOutput.includes("deepseek-v4.1-flash-free"), "repair diff line must be dropped");
    assert.ok(!logOutput.includes("beam-free"), "fallback repair diff line must be dropped");

    // Touch file without any changes: verify all diff lines dropped and no reload log printed
    const touchTime = new Date(Date.now() + 4000);
    fs.utimesSync(configPath, touchTime, touchTime);

    const touchLogs = [];
    console.log = (...args) => touchLogs.push(args.join(" "));
    try {
      reloadConfigIfChanged(liveC, configPath);
    } finally {
      console.log = origLog;
    }

    assert.equal(
      liveC.roles.implementer.model,
      "opencode/deepseek-v4.1-flash-free",
      "repaired primary model id remains preserved after touch"
    );
    assert.equal(
      liveC.roles.implementer.fallbacks[0].model,
      "opencode/beam-free",
      "repaired fallback model id remains preserved after touch"
    );
    assert.equal(touchLogs.length, 0, "no log output when only repair diff lines would have been printed");

    console.log("PASS reloadConfigIfChanged: bare id in file keeps repaired id in c across reload");
  } finally {
    setLiveConfigRepairsForTests([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log("test-config-reload: all cases passed");
