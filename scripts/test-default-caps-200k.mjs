#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateConfig } from "./config-migration.mjs";
import { validatePolicyConfig, validateNewConfig } from "./config-validation.mjs";
import {
  mergeRoleCaps,
  PER_TASK_MAX_TURNS_DEFAULT,
  PER_TASK_MAX_TOKENS_DEFAULT,
  CONTINUATION_ALLOWANCE_DEFAULT,
  HANDOFF_MAX_CHARS_DEFAULT,
  HANDOFF_NOTE_MAX_CHARS_DEFAULT,
  HANDOFF_WRAPUP_TOKENS_DEFAULT,
  NO_PROGRESS_GENERATIONS_DEFAULT,
  BACKSTOP_RAW_TOKENS_DEFAULT,
} from "./per-task-budget.mjs";
import { toRuntimeConfig, toNewLayoutConfig } from "./config-layout.mjs";
import { fillConfigFile } from "./config-fill.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// (a) old shipped defaults (180000/150000/150000 + wrap-ups) migrate to new
// defaults: 200000/250000/200000 (+ 180000/225000/180000)
// ---------------------------------------------------------------------------

test("(a) legacy runtime config with old shipped defaults migrates to new defaults", () => {
  const legacyConfig = {
    schema_version: "3.0",
    project: { planning_framework: "gsd" },
    roles: {},
    policy: {
      per_task_max_tokens: 180000,
      handoff_wrapup_tokens: 160000,
      caps: {
        planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_tokens_threshold: 180000 },
        plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4, wrap_up_tokens_threshold: 225000 },
        code_reviewer: { max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_tokens_threshold: 135000 },
        verifier: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_tokens_threshold: 135000 },
      },
    },
  };

  const { config, changed } = migrateConfig(legacyConfig);
  assert.equal(changed, true, "migration must flag changed=true");
  assert.equal(config.caps.implementer.max_tokens, 200000, "implementer max_tokens must be 200000");
  assert.equal(config.caps.implementer.wrap_up_at_tokens, 180000, "implementer wrap_up_at_tokens must be 180000");
  assert.equal(config.caps.code_reviewer.max_tokens, 250000, "code_reviewer max_tokens must be 250000");
  assert.equal(config.caps.code_reviewer.wrap_up_at_tokens, 225000, "code_reviewer wrap_up_at_tokens must be 225000");
  assert.equal(config.caps.verifier.max_tokens, 200000, "verifier max_tokens must be 200000");
  assert.equal(config.caps.verifier.wrap_up_at_tokens, 180000, "verifier wrap_up_at_tokens must be 180000");
  assert.equal(config.advanced.handoff_wrapup_tokens, 180000, "advanced handoff_wrapup_tokens must be 180000");
});

test("(a) v4 layout config with old shipped defaults migrates to new defaults", () => {
  const v4Config = {
    schema_version: "4.0",
    caps: {
      planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
      plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4, wrap_up_at_tokens: 225000 },
      implementer: { max_turns: 40, max_tokens: 180000, extra_sessions: 5, wrap_up_at_tokens: 160000 },
      code_reviewer: { max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
      verifier: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    },
    advanced: {
      handoff_wrapup_tokens: 160000,
    },
  };

  const { config, changed } = migrateConfig(v4Config);
  assert.equal(changed, true, "migration must flag changed=true");
  assert.equal(config.caps.implementer.max_tokens, 200000, "implementer max_tokens must be 200000");
  assert.equal(config.caps.implementer.wrap_up_at_tokens, 180000, "implementer wrap_up_at_tokens must be 180000");
  assert.equal(config.caps.code_reviewer.max_tokens, 250000, "code_reviewer max_tokens must be 250000");
  assert.equal(config.caps.code_reviewer.wrap_up_at_tokens, 225000, "code_reviewer wrap_up_at_tokens must be 225000");
  assert.equal(config.caps.verifier.max_tokens, 200000, "verifier max_tokens must be 200000");
  assert.equal(config.caps.verifier.wrap_up_at_tokens, 180000, "verifier wrap_up_at_tokens must be 180000");
  assert.equal(config.advanced.handoff_wrapup_tokens, 180000, "advanced handoff_wrapup_tokens must be 180000");
});

test("(a) mergeRoleCaps migrates old shipped defaults", () => {
  const merged = mergeRoleCaps({
    code_reviewer: { max_tokens: 150000, wrap_up_tokens_threshold: 135000 },
    verifier: { max_tokens: 150000, wrap_up_tokens_threshold: 135000 },
  });
  assert.equal(merged.code_reviewer.max_tokens, 250000, "code_reviewer max_tokens must be 250000");
  assert.equal(merged.code_reviewer.wrap_up_tokens_threshold, 225000, "code_reviewer wrap_up_tokens_threshold must be 225000");
  assert.equal(merged.verifier.max_tokens, 200000, "verifier max_tokens must be 200000");
  assert.equal(merged.verifier.wrap_up_tokens_threshold, 180000, "verifier wrap_up_tokens_threshold must be 180000");
});

// ---------------------------------------------------------------------------
// (b) operator value like code_reviewer 170000 is kept
// ---------------------------------------------------------------------------

test("(b) operator value code_reviewer 170000 is kept across legacy migration", () => {
  const legacy = {
    schema_version: "3.0",
    project: { planning_framework: "gsd" },
    policy: {
      caps: {
        code_reviewer: { max_tokens: 170000, wrap_up_tokens_threshold: 150000 },
      },
    },
  };
  const { config } = migrateConfig(legacy);
  assert.equal(config.caps.code_reviewer.max_tokens, 170000, "operator code_reviewer 170000 must be kept");
  assert.equal(config.caps.code_reviewer.wrap_up_at_tokens, 150000, "operator wrap_up 150000 must be kept");
});

test("(b) operator value code_reviewer 170000 is kept across v4 migration", () => {
  const v4 = {
    schema_version: "4.0",
    caps: {
      code_reviewer: { max_turns: 22, max_tokens: 170000, extra_sessions: 2, wrap_up_at_tokens: 150000 },
    },
  };
  const { config, changed } = migrateConfig(v4);
  assert.equal(changed, false, "no migration rewrite expected for operator value");
  assert.equal(config.caps.code_reviewer.max_tokens, 170000, "operator code_reviewer 170000 must be kept");
  assert.equal(config.caps.code_reviewer.wrap_up_at_tokens, 150000, "operator wrap_up 150000 must be kept");
});

test("(b) mergeRoleCaps preserves operator value code_reviewer 170000", () => {
  const merged = mergeRoleCaps({
    code_reviewer: { max_tokens: 170000, wrap_up_tokens_threshold: 150000 },
  });
  assert.equal(merged.code_reviewer.max_tokens, 170000, "operator code_reviewer 170000 must be preserved");
  assert.equal(merged.code_reviewer.wrap_up_tokens_threshold, 150000, "operator wrap_up 150000 must be preserved");
});

// ---------------------------------------------------------------------------
// (c) a config with code_reviewer 250000 and implementer 200000 passes validation
// ---------------------------------------------------------------------------

test("(c) policy config with code_reviewer 250000 and implementer 200000 passes validatePolicyConfig", () => {
  const policy = {
    per_task_max_tokens: 200000,
    handoff_wrapup_tokens: 180000,
    caps: {
      code_reviewer: { max_turns: 22, max_tokens: 250000, extra_sessions: 2, wrap_up_tokens_threshold: 225000 },
      verifier: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_tokens_threshold: 180000 },
    },
  };
  const validation = validatePolicyConfig(policy);
  assert.equal(validation.valid, true, `Expected valid policy but got errors: ${validation.errors.join("; ")}`);
  assert.equal(validation.errors.length, 0, "No errors expected");
});

test("(c) full v4 config with new defaults passes validateNewConfig", () => {
  const config = {
    $schema: "./config.schema.json",
    schema_version: "4.0",
    caps: {
      planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
      plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4, wrap_up_at_tokens: 225000 },
      implementer: { max_turns: 40, max_tokens: 200000, extra_sessions: 5, wrap_up_at_tokens: 180000 },
      code_reviewer: { max_turns: 22, max_tokens: 250000, extra_sessions: 2, wrap_up_at_tokens: 225000 },
      verifier: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
    },
    advanced: {
      handoff_wrapup_tokens: 180000,
    },
  };
  const validation = validateNewConfig(config);
  assert.equal(validation.valid, true, `Expected valid config but got errors: ${validation.errors.join("; ")}`);
  assert.equal(validation.errors.length, 0, "No errors expected");
});

// ---------------------------------------------------------------------------
// Unit regressions: setup --edit path with operator caps
// ---------------------------------------------------------------------------

const basePolicy = {
  max_plan_revisions: 8,
  per_task_max_turns: PER_TASK_MAX_TURNS_DEFAULT,
  per_task_max_tokens: PER_TASK_MAX_TOKENS_DEFAULT,
  continuation_allowance: CONTINUATION_ALLOWANCE_DEFAULT,
  handoff_max_chars: HANDOFF_MAX_CHARS_DEFAULT,
  handoff_note_max_chars: HANDOFF_NOTE_MAX_CHARS_DEFAULT,
  handoff_wrapup_tokens: HANDOFF_WRAPUP_TOKENS_DEFAULT,
  no_progress_generations: NO_PROGRESS_GENERATIONS_DEFAULT,
  backstop_raw_tokens: BACKSTOP_RAW_TOKENS_DEFAULT,
  failure_budgets: {
    implementationFailureBudget: 5,
    verificationFailureBudget: 5,
    adapterRetryBudget: 3,
    infrastructureRetryBudget: 3,
  },
  checkpoint_after_task: true,
  checkpoint_after_phase: true,
  require_human_commit: true,
  fail_closed_on_relay_violation: true,
};

test("setup path regression (step 1): operator wrap_up_at_tokens 150000 on verifier (max_tokens 170000) is kept and valid", () => {
  // Reproducing the setup --edit flow for a v4 config
  const rawV4 = {
    $schema: "./config.schema.json",
    schema_version: "4.0",
    caps: {
      planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
      plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4, wrap_up_at_tokens: 225000 },
      implementer: { max_turns: 40, max_tokens: 200000, extra_sessions: 5, wrap_up_at_tokens: 180000 },
      code_reviewer: { max_turns: 22, max_tokens: 250000, extra_sessions: 2, wrap_up_at_tokens: 225000 },
      verifier: { max_turns: 15, max_tokens: 170000, extra_sessions: 3, wrap_up_at_tokens: 150000 },
    },
    advanced: { handoff_wrapup_tokens: 180000 },
  };

  const { config: migratedLayout } = migrateConfig(rawV4);
  const runtime = toRuntimeConfig(migratedLayout);
  const mergedPolicy = {
    ...basePolicy,
    ...(runtime?.policy || {}),
  };
  mergedPolicy.caps = mergeRoleCaps(mergedPolicy.caps || {});

  const validation = validatePolicyConfig(mergedPolicy);
  assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join("; ")}`);
  assert.equal(mergedPolicy.caps.verifier.max_tokens, 170000, "operator max_tokens 170000 must be kept");
  assert.equal(mergedPolicy.caps.verifier.wrap_up_tokens_threshold, 150000, "operator wrap_up 150000 must be kept");

  const newLayout = toNewLayoutConfig({ ...runtime, policy: mergedPolicy });
  assert.equal(newLayout.caps.verifier.max_tokens, 170000);
  assert.equal(newLayout.caps.verifier.wrap_up_at_tokens, 150000);
});

test("setup path regression (step 1 legacy): operator wrap_up_at_tokens in legacy config is migrated, kept and valid", () => {
  // Reproducing the setup --edit flow for a legacy v3 config (as used by test-setup-role-caps fixture)
  const rawV3 = {
    schema_version: "3.0",
    project: { repo: ".", planning_framework: "standalone" },
    policy: {
      caps: {
        planner: { max_turns: 30 },
        verifier: { max_turns: 15, max_tokens: 170000, extra_sessions: 3, wrap_up_at_tokens: 150000 },
      },
    },
  };

  const { config: migratedLayout } = migrateConfig(rawV3);
  const runtime = toRuntimeConfig(migratedLayout);
  const mergedPolicy = {
    ...basePolicy,
    ...(runtime?.policy || {}),
  };
  mergedPolicy.caps = mergeRoleCaps(mergedPolicy.caps || {});

  const validation = validatePolicyConfig(mergedPolicy);
  assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join("; ")}`);
  assert.equal(mergedPolicy.caps.verifier.max_tokens, 170000, "operator max_tokens 170000 must be kept");
  assert.equal(mergedPolicy.caps.verifier.wrap_up_tokens_threshold, 150000, "operator wrap_up 150000 must be kept");

  const newLayout = toNewLayoutConfig({ ...runtime, policy: mergedPolicy });
  assert.equal(newLayout.caps.verifier.max_tokens, 170000);
  assert.equal(newLayout.caps.verifier.wrap_up_at_tokens, 150000);
});

test("setup path regression (step 2): operator max_tokens below default wrap-up with NO wrap-up set gets safe wrap-up", () => {
  // Verifier max_tokens: 170000 (< default wrap-up 180000), no wrap-up specified
  const raw = {
    $schema: "./config.schema.json",
    schema_version: "4.0",
    caps: {
      verifier: { max_tokens: 170000 },
    },
  };

  const { config: migratedLayout } = migrateConfig(raw);
  const runtime = toRuntimeConfig(migratedLayout);
  const mergedPolicy = {
    ...basePolicy,
    ...(runtime?.policy || {}),
  };
  mergedPolicy.caps = mergeRoleCaps(mergedPolicy.caps || {});

  const validation = validatePolicyConfig(mergedPolicy);
  assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join("; ")}`);
  assert.equal(mergedPolicy.caps.verifier.max_tokens, 170000, "operator max_tokens 170000 must be kept");
  assert.ok(
    mergedPolicy.caps.verifier.wrap_up_tokens_threshold < mergedPolicy.caps.verifier.max_tokens,
    `wrap_up (${mergedPolicy.caps.verifier.wrap_up_tokens_threshold}) must be strictly below max_tokens (${mergedPolicy.caps.verifier.max_tokens})`
  );
  assert.equal(
    mergedPolicy.caps.verifier.wrap_up_tokens_threshold,
    Math.floor(170000 * 0.9),
    "safe default wrap-up must be 90% of cap"
  );
});

// ---------------------------------------------------------------------------
// ap config fill: v4 layout migration of old shipped cap defaults
// ---------------------------------------------------------------------------

test("ap config fill moves old shipped cap defaults to new defaults in v4 config", () => {
  const tmpTestDir = path.join(here, `.tmp-fill-test-${Date.now()}`);
  fs.mkdirSync(path.join(tmpTestDir, ".autopilot"), { recursive: true });
  const configPath = path.join(tmpTestDir, ".autopilot", "config.json");

  // Old numbers v4 config
  const oldV4 = {
    $schema: "./config.schema.json",
    schema_version: "4.0",
    caps: {
      planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
      plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4, wrap_up_at_tokens: 225000 },
      implementer: { max_turns: 40, max_tokens: 180000, extra_sessions: 5, wrap_up_at_tokens: 160000 },
      code_reviewer: { max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
      verifier: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    },
    advanced: {
      handoff_wrapup_tokens: 160000,
    },
  };

  try {
    fs.writeFileSync(configPath, `${JSON.stringify(oldV4, null, 2)}\n`);
    const initialRaw = fs.readFileSync(configPath, "utf8");

    // (a) dryRun -> result.updated has the 6 cap changes + advanced.handoff_wrapup_tokens, file unchanged
    const dryResult = fillConfigFile(configPath, { dryRun: true });
    assert.equal(dryResult.changed, true, "dryRun reports changed");
    assert.equal(dryResult.written, false, "dryRun does not write");
    assert.equal(dryResult.backupPath, null, "dryRun creates no backup");
    assert.equal(fs.readFileSync(configPath, "utf8"), initialRaw, "dryRun leaves file unchanged");

    assert.equal(dryResult.updated.length, 7, "expected 7 updated entries (6 cap changes + advanced)");
    const updatedPaths = dryResult.updated.map((u) => u.path);
    assert.deepEqual(
      updatedPaths.sort(),
      [
        "advanced.handoff_wrapup_tokens",
        "caps.code_reviewer.max_tokens",
        "caps.code_reviewer.wrap_up_at_tokens",
        "caps.implementer.max_tokens",
        "caps.implementer.wrap_up_at_tokens",
        "caps.verifier.max_tokens",
        "caps.verifier.wrap_up_at_tokens",
      ].sort()
    );

    const findChange = (p) => dryResult.updated.find((u) => u.path === p);
    assert.deepEqual(findChange("caps.implementer.max_tokens"), { path: "caps.implementer.max_tokens", from: 180000, to: 200000 });
    assert.deepEqual(findChange("caps.implementer.wrap_up_at_tokens"), { path: "caps.implementer.wrap_up_at_tokens", from: 160000, to: 180000 });
    assert.deepEqual(findChange("caps.code_reviewer.max_tokens"), { path: "caps.code_reviewer.max_tokens", from: 150000, to: 250000 });
    assert.deepEqual(findChange("caps.code_reviewer.wrap_up_at_tokens"), { path: "caps.code_reviewer.wrap_up_at_tokens", from: 135000, to: 225000 });
    assert.deepEqual(findChange("caps.verifier.max_tokens"), { path: "caps.verifier.max_tokens", from: 150000, to: 200000 });
    assert.deepEqual(findChange("caps.verifier.wrap_up_at_tokens"), { path: "caps.verifier.wrap_up_at_tokens", from: 135000, to: 180000 });
    assert.deepEqual(findChange("advanced.handoff_wrapup_tokens"), { path: "advanced.handoff_wrapup_tokens", from: 160000, to: 180000 });

    // (b) real run -> file now has 200000/180000, 250000/225000, 200000/180000, advanced 180000, a .bak file exists
    const realResult = fillConfigFile(configPath);
    assert.equal(realResult.changed, true, "real run reports changed");
    assert.equal(realResult.written, true, "real run writes");
    assert.ok(realResult.backupPath && fs.existsSync(realResult.backupPath), ".bak file must exist");
    assert.equal(fs.readFileSync(realResult.backupPath, "utf8"), initialRaw, "backup matches original file");

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(writtenConfig.caps.implementer.max_tokens, 200000);
    assert.equal(writtenConfig.caps.implementer.wrap_up_at_tokens, 180000);
    assert.equal(writtenConfig.caps.code_reviewer.max_tokens, 250000);
    assert.equal(writtenConfig.caps.code_reviewer.wrap_up_at_tokens, 225000);
    assert.equal(writtenConfig.caps.verifier.max_tokens, 200000);
    assert.equal(writtenConfig.caps.verifier.wrap_up_at_tokens, 180000);
    assert.equal(writtenConfig.advanced.handoff_wrapup_tokens, 180000);

    // (c) second run -> changed false, nothing updated
    const secondResult = fillConfigFile(configPath);
    assert.equal(secondResult.changed, false, "second run reports not changed");
    assert.equal(secondResult.written, false, "second run does not write");
    assert.deepEqual(secondResult.updated, [], "second run has empty updated");

    // (d) operator code_reviewer 170000/150000 kept and not in updated
    const operatorConfig = {
      $schema: "./config.schema.json",
      schema_version: "4.0",
      caps: {
        implementer: { max_turns: 40, max_tokens: 180000, extra_sessions: 5, wrap_up_at_tokens: 160000 },
        code_reviewer: { max_turns: 22, max_tokens: 170000, extra_sessions: 2, wrap_up_at_tokens: 150000 },
        verifier: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(operatorConfig, null, 2)}\n`);
    const opResult = fillConfigFile(configPath);
    assert.equal(opResult.changed, true);
    assert.ok(!opResult.updated.some((u) => u.path.startsWith("caps.code_reviewer")), "code_reviewer must not be in updated");
    const opWritten = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(opWritten.caps.code_reviewer.max_tokens, 170000, "operator code_reviewer max_tokens must be preserved");
    assert.equal(opWritten.caps.code_reviewer.wrap_up_at_tokens, 150000, "operator code_reviewer wrap_up must be preserved");
  } finally {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  }
});

console.log(`\nAll ${passed} tests passed.`);
