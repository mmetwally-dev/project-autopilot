#!/usr/bin/env node
// Mission 087 task 1.2: per-role `fallbacks` preservation + validation.
// - migrateConfig round-trips valid ordered fallbacks; roles without
//   `fallbacks` gain no key and a clean config is not marked changed.
// - validateRoleSelection + validateConfigForSave reject invalid fallback
//   entries with a clear `fallbacks[i]` error; absent fallbacks validate
//   exactly as before.
// - validateRoleRuntimeConfig (scripts/autopilot.mjs, not importable — it
//   runs main() on import) is asserted at the source level: it must check
//   each fallback entry's adapter/model/reasoning/variant.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateConfig, loadAndMigrateConfig } from "./config-migration.mjs";
import { toRuntimeConfig } from "./config-layout.mjs";
import { validateRoleSelection, validateConfigForSave } from "./config-validation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// --- Fake CLIs: one advertising model+effort+variant, one advertising none.
function makeBinaries() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fallback-cfg-"));
  const full = path.join(temporary, "fake-full");
  const bare = path.join(temporary, "fake-bare");
  if (process.platform === "win32") {
    throw new Error("test supports POSIX only");
  }
  fs.writeFileSync(full, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--model MODEL --effort LEVEL --variant VAR --resume-last"; else echo ok; fi\n');
  fs.writeFileSync(bare, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--help nothing-useful"; else echo ok; fi\n');
  fs.chmodSync(full, 0o755);
  fs.chmodSync(bare, 0o755);
  return { temporary, full, bare };
}
const { temporary, full: fullBin, bare: bareBin } = makeBinaries();
const fullAdapter = { binary: fullBin, probe: ["--help"], write: ["run"], read_only: ["plan"], model_flag: "--model", effort_flag: "--effort", variant_flag: "--variant", model_discovery: "manual" };
const bareAdapter = { binary: bareBin, probe: ["--help"], write: ["run"], read_only: ["plan"], model_flag: null, effort_flag: null, variant_flag: null, model_discovery: "manual" };
const agents = { full: fullAdapter, bare: bareAdapter };

function baseRoles() {
  return Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"]
    .map((role) => [role, { adapter: "full", model: "", reasoning: "", variant: "", resume: true, model_source: "test", model_verified_at: null, capabilities_verified_at: null }]));
}
function migratedInput(roles) {
  return {
    schema_version: "3.0",
    config_metadata: { migrated_from: "3.0", last_migrated_at: new Date(0).toISOString() },
    project: { planning_framework: "standalone" },
    roles,
    policy: {
      failure_budgets: { implementationFailureBudget: 4, verificationFailureBudget: 4, adapterRetryBudget: 3, infrastructureRetryBudget: 3 },
      per_task_max_turns: 40, per_task_max_tokens: 180000, continuation_allowance: 3,
      handoff_max_chars: 2000, handoff_note_max_chars: 4000, handoff_wrapup_tokens: 160000,
      no_progress_generations: 2, final_review_fix_rounds: 2, backstop_raw_tokens: 6000000, idle_hang_ms: 600000,
      caps: {
        planner: { max_turns: 22, max_tokens: 200000, extra_sessions: 2, wrap_up_tokens_threshold: 180000 },
        plan_reviewer: { max_turns: 18, max_tokens: 150000, extra_sessions: 2, wrap_up_tokens_threshold: 135000 },
        code_reviewer: { max_turns: 22, max_tokens: 150000, extra_sessions: 0, wrap_up_tokens_threshold: 135000 },
        verifier: { max_turns: 15, max_tokens: 150000, extra_sessions: 3, wrap_up_tokens_threshold: 135000 },
      },
    },
    capabilities: { project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: { browser: "native", require_browser: "when-task-requires" } },
    planning: { verify_denylist: [] },
  };
}

try {
  // 1. Round-trip keeps valid ordered fallbacks.
  {
    const roles = baseRoles();
    roles.implementer.fallbacks = [
      { adapter: "full", model: "fallback-one", reasoning: "", variant: "" },
      { adapter: "full", model: "fallback-two", reasoning: "", variant: "" },
    ];
    const config = toRuntimeConfig(migrateConfig(migratedInput(roles)).config);
    assert.deepEqual(config.roles.implementer.fallbacks, roles.implementer.fallbacks, "valid fallbacks survive migration in order");
    console.log("PASS round-trip-keeps-valid-fallbacks");
  }

  // 2. Config without fallbacks gains no key and is not marked changed.
  // Test through the full load path (legacy -> v4 -> legacy -> v4) so the
  // idempotence check exercises meta persistence and marker survival.
  {
    const first = migrateConfig(migratedInput(baseRoles()));
    const firstRuntime = toRuntimeConfig(first.config);
    for (const name of Object.keys(firstRuntime.roles)) {
      assert.ok(!("fallbacks" in firstRuntime.roles[name]), `${name} gains no fallbacks key`);
    }
    // Second pass: migrate the v4 layout again (simulating a reload).
    // Since the input is already v4, migrateConfig returns it unchanged.
    const second = migrateConfig(first.config);
    assert.equal(second.changed, false, "clean config without fallbacks is not marked changed");
    // Drive the real load path: persist legacy input twice. The second load
    // must be a no-op (no change, no new backup, same meta file content).
    const dir = fs.mkdtempSync(path.join(temporary, "idem-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(migratedInput(baseRoles()), null, 2));
    const firstLoad = loadAndMigrateConfig(configPath, { persist: true });
    assert.equal(firstLoad.changed, true, "legacy input is migrated on first load");
    const backupsAfterFirst = fs.readdirSync(dir).filter((name) => name.includes(".bak-")).sort();
    assert.equal(backupsAfterFirst.length, 1, "first load writes exactly one backup");
    const metaAfterFirst = fs.readFileSync(path.join(dir, "config.meta.json"), "utf8");
    const configAfterFirst = fs.readFileSync(configPath, "utf8");
    const secondLoad = loadAndMigrateConfig(configPath, { persist: true });
    assert.equal(secondLoad.changed, false, "second load of persisted config is not marked changed");
    assert.equal(secondLoad.backupPath, null, "second load writes no backup");
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".bak-")).sort(), backupsAfterFirst, "no new backup file on second load");
    assert.equal(fs.readFileSync(path.join(dir, "config.meta.json"), "utf8"), metaAfterFirst, "meta file content unchanged on second load");
    assert.equal(fs.readFileSync(configPath, "utf8"), configAfterFirst, "config file unchanged on second load");
    console.log("PASS no-fallbacks-unchanged");
  }

  // 3. validateRoleSelection: valid fallbacks pass; absent fallbacks behave as today.
  {
    const role = { adapter: "full", model: "", reasoning: "", variant: "", resume: false, fallbacks: [{ adapter: "full", model: "", reasoning: "", variant: "" }] };
    const ok = await validateRoleSelection({ roleName: "implementer", role, adapter: fullAdapter, agents });
    assert.equal(ok.valid, true, `valid fallbacks must pass, got ${JSON.stringify(ok.errors)}`);
    const bare = await validateRoleSelection({ roleName: "implementer", role: { adapter: "full", model: "", reasoning: "", variant: "", resume: false }, adapter: fullAdapter, agents });
    assert.equal(bare.valid, true, `absent fallbacks must validate as before, got ${JSON.stringify(bare.errors)}`);
    console.log("PASS absent-fallbacks-behave-as-today");
  }

  // 4. validateRoleSelection + validateConfigForSave reject invalid entries clearly.
  {
    const cases = [
      ["unknown adapter", [{ adapter: "nope", model: "m" }], /fallbacks\[0\].*adapter/i],
      ["model without capability", [{ adapter: "bare", model: "m" }], /fallbacks\[0\].*model selection/i],
      ["reasoning without capability", [{ adapter: "bare", model: "", reasoning: "high" }], /fallbacks\[0\].*effort\/reasoning/i],
      ["variant without capability", [{ adapter: "bare", model: "", variant: "v" }], /fallbacks\[0\].*variant/i],
      ["non-array fallbacks", "nope", /fallbacks.*array/i],
      ["non-object entry", ["nope"], /fallbacks\[0\].*object/i],
    ];
    for (const [label, fallbacks, re] of cases) {
      const role = { adapter: "full", model: "", reasoning: "", variant: "", resume: false, fallbacks };
      const r = await validateRoleSelection({ roleName: "implementer", role, adapter: fullAdapter, agents });
      assert.equal(r.valid, false, `${label}: expected invalid`);
      assert.ok(r.errors.some((e) => re.test(e)), `${label}: expected clear fallbacks error, got ${JSON.stringify(r.errors)}`);
    }
    const badRoles = baseRoles();
    badRoles.implementer.fallbacks = [{ adapter: "bare", model: "m" }];
    const saved = await validateConfigForSave({ roles: badRoles, agents, capabilities: {} });
    assert.equal(saved.valid, false, "validateConfigForSave must surface fallback errors");
    assert.ok(saved.errors.some((e) => /fallbacks\[0\]/.test(e)), `expected fallbacks error, got ${JSON.stringify(saved.errors)}`);
    const goodRoles = baseRoles();
    const savedOk = await validateConfigForSave({ roles: goodRoles, agents, capabilities: {} });
    assert.equal(savedOk.valid, true, `fallback-free save must stay valid, got ${JSON.stringify(savedOk.errors)}`);
    console.log("PASS invalid-entries-error-clearly");
  }

  // 5. autopilot.mjs validateRoleRuntimeConfig covers fallbacks (source-level:
  //    the module runs main() on import so it cannot be imported here).
  {
    const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
    const block = src.slice(src.indexOf("function validateRoleRuntimeConfig"));
    assert.ok(block.includes("role.fallbacks"), "validateRoleRuntimeConfig must inspect role.fallbacks");
    for (const key of ["fb.adapter", "fb.model", "fb.reasoning", "fb.variant"]) {
      assert.ok(block.includes(key), `validateRoleRuntimeConfig must check ${key}`);
    }
    assert.ok(block.includes("fallbacks[${"), "fallback errors must name the entry index");
    console.log("PASS runtime-config-validates-fallbacks");
  }

  console.log("test-role-fallback-config: all cases passed");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
