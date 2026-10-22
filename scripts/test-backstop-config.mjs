#!/usr/bin/env node
// Mission 047 Phase 2 task 2.1 — backstop config surface.
//
// Per-role policy.caps key (policy.caps.<role>.backstop_raw_tokens) and the
// policy-level implementer key (policy.backstop_raw_tokens): precedence
// resolution, validation, migration/setup seeding.
// Accept: per-role and policy-level keys resolve with precedence and seed
// cleanly, and a 6,000,000 backstop value (both per-role and policy-level
// keys) survives migrateConfig unchanged and passes validatePolicyConfig.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  BACKSTOP_RAW_TOKENS_DEFAULT,
  resolveBackstopRawTokens,
  mergeRoleCaps,
} from "./per-task-budget.mjs";
import {validatePolicyConfig} from "./config-validation.mjs";
import {migrateConfig} from "./config-migration.mjs";
import {toRuntimeConfig} from "./config-layout.mjs";

// migrateConfig now yields the v4 layout; wrap it back to the runtime shape the
// policy resolvers/validation read.
const migrate = (input) => {
  const result = migrateConfig(input);
  return {...result, config: toRuntimeConfig(result.config)};
};

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

// ── Resolve precedence (both keys) ─────────────────────────────────────
{
  check("surface: default is 6M", BACKSTOP_RAW_TOKENS_DEFAULT === 6_000_000, BACKSTOP_RAW_TOKENS_DEFAULT);
  check("resolve: absent policy is the 6M default",
    resolveBackstopRawTokens({}) === 6_000_000);
  check("resolve: policy-level key wins over the default",
    resolveBackstopRawTokens({backstop_raw_tokens: 1_000}) === 1_000);
  check("resolve: per-role caps key wins over the policy-level key (review role)",
    resolveBackstopRawTokens({backstop_raw_tokens: 1_000, caps: {planner: {backstop_raw_tokens: 2_000}}}, "planner") === 2_000);
  check("resolve: implementer ignores caps.implementer — the policy-level key configures it",
    resolveBackstopRawTokens({backstop_raw_tokens: 1_000, caps: {implementer: {backstop_raw_tokens: 2_000}}}, "implementer") === 1_000);
  check("resolve: role without a per-role key inherits the policy-level key",
    resolveBackstopRawTokens({backstop_raw_tokens: 1_000, caps: {planner: {backstop_raw_tokens: 2_000}}}, "verifier") === 1_000);
  check("resolve: invalid keys fall back to the 6M default, never unbounded",
    resolveBackstopRawTokens({backstop_raw_tokens: 0}) === 6_000_000
    && resolveBackstopRawTokens({backstop_raw_tokens: -5, caps: {planner: {backstop_raw_tokens: 0}}}, "planner") === 6_000_000);
}

// ── Validation ─────────────────────────────────────────────────────────
{
  check("validate: absent backstop keys are valid (code default)",
    validatePolicyConfig({}).valid === true);
  check("accept: 6M policy-level key passes validatePolicyConfig",
    validatePolicyConfig({backstop_raw_tokens: 6_000_000}).valid === true);
  const perRole6M = {
    caps: {planner: {max_turns: 22, max_tokens: 200_000, extra_sessions: 2, backstop_raw_tokens: 6_000_000}},
  };
  const rRole = validatePolicyConfig(perRole6M);
  check("accept: 6M per-role key passes validatePolicyConfig",
    rRole.valid === true, rRole);
  for (const bad of [0, -5, 1.5, "lots"]) {
    const rPolicy = validatePolicyConfig({backstop_raw_tokens: bad});
    check(`validate: policy-level ${JSON.stringify(bad)} rejected`,
      rPolicy.valid === false && rPolicy.errors.some((e) => e.includes("policy.backstop_raw_tokens")), rPolicy);
    const rCaps = validatePolicyConfig({
      caps: {planner: {max_turns: 22, max_tokens: 200_000, extra_sessions: 2, backstop_raw_tokens: bad}},
    });
    check(`validate: per-role ${JSON.stringify(bad)} rejected`,
      rCaps.valid === false && rCaps.errors.some((e) => e.includes("policy.caps.planner.backstop_raw_tokens")), rCaps);
  }
  // The backstop key must not disturb the existing caps contract: an
  // implementer caps entry is still an unknown role, and the required
  // review-role fields are still required.
  check("validate: implementer caps entry still rejected (implementer uses the policy-level key)",
    validatePolicyConfig({caps: {implementer: {max_turns: 20, max_tokens: 400000, extra_sessions: 1, backstop_raw_tokens: 2_000}}}).valid === false);
  check("validate: review-role entry missing max_turns still rejected with a backstop key present",
    validatePolicyConfig({caps: {planner: {max_tokens: 200_000, extra_sessions: 2, backstop_raw_tokens: 6_000_000}}}).valid === false);
}

// ── Migration: seeding + 6M survival ───────────────────────────────────
{
  const fresh = migrate({schema_version: "1.4", project: {planning_framework: "standalone"}, roles: {}});
  check("seed: migration backfills the 6M policy-level default when absent",
    fresh.config.policy.backstop_raw_tokens === 6_000_000, fresh.config.policy.backstop_raw_tokens);
  check("seed: migrated fresh policy passes validatePolicyConfig",
    validatePolicyConfig(fresh.config.policy).valid === true,
    validatePolicyConfig(fresh.config.policy));

  const explicit6M = migrate({schema_version: "3.0", project: {planning_framework: "standalone"}, roles: {}, policy: {
    backstop_raw_tokens: 6_000_000,
    caps: {planner: {max_turns: 22, max_tokens: 200_000, extra_sessions: 2, wrap_up_tokens_threshold: 180_000, backstop_raw_tokens: 6_000_000}},
  }});
  check("accept: 6M policy-level key survives migrateConfig unchanged",
    explicit6M.config.policy.backstop_raw_tokens === 6_000_000, explicit6M.config.policy.backstop_raw_tokens);
  check("accept: 6M per-role key survives migrateConfig unchanged",
    explicit6M.config.policy.caps.planner.backstop_raw_tokens === 6_000_000, explicit6M.config.policy.caps.planner);
  const v6M = validatePolicyConfig(explicit6M.config.policy);
  check("accept: migrated 6M config (both keys) passes validatePolicyConfig",
    v6M.valid === true, v6M);

  const custom = migrate({schema_version: "3.0", project: {planning_framework: "standalone"}, roles: {}, policy: {
    backstop_raw_tokens: 4_000_000,
    caps: {verifier: {max_turns: 22, max_tokens: 150_000, extra_sessions: 2, wrap_up_tokens_threshold: 135_000, backstop_raw_tokens: 8_000_000}},
  }});
  check("migrate: custom operator backstop values preserved, never rewritten",
    custom.config.policy.backstop_raw_tokens === 4_000_000
    && custom.config.policy.caps.verifier.backstop_raw_tokens === 8_000_000,
    {policy: custom.config.policy.backstop_raw_tokens, verifier: custom.config.policy.caps.verifier?.backstop_raw_tokens});
  check("migrate: custom backstop config still validates",
    validatePolicyConfig(custom.config.policy).valid === true,
    validatePolicyConfig(custom.config.policy));
}

// ── Per-role seeding: mergeRoleCaps preserves operator backstop values ──
{
  const caps = mergeRoleCaps({planner: {backstop_raw_tokens: 8_000_000}});
  check("seed: mergeRoleCaps keeps a per-role operator backstop value",
    caps.planner.backstop_raw_tokens === 8_000_000, caps.planner);
  check("seed: mergeRoleCaps still resolves the kept value with precedence",
    resolveBackstopRawTokens({backstop_raw_tokens: 6_000_000, caps}, "planner") === 8_000_000);
  const merged = mergeRoleCaps({});
  check("seed: mergeRoleCaps output validates (no backstop default required per role)",
    validatePolicyConfig({backstop_raw_tokens: 6_000_000, caps: merged}).valid === true,
    validatePolicyConfig({backstop_raw_tokens: 6_000_000, caps: merged}));
}

// ── Setup seeding (static: setup.mjs basePolicy carries the default) ────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const setupSrc = fs.readFileSync(path.join(here, "setup.mjs"), "utf8");
  check("seed: setup.mjs seeds the policy-level backstop default from the code constant",
    setupSrc.includes("backstop_raw_tokens: BACKSTOP_RAW_TOKENS_DEFAULT")
    && /BACKSTOP_RAW_TOKENS_DEFAULT[^}]*mergeRoleCaps|mergeRoleCaps[^;]*BACKSTOP_RAW_TOKENS_DEFAULT|import\s*\{[^}]*BACKSTOP_RAW_TOKENS_DEFAULT[^}]*\}\s*from\s*"\.\/per-task-budget\.mjs"/.test(setupSrc));
}

// ── Discovery ────────────────────────────────────────────────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-backstop-config.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-backstop-config.mjs"));
  check("discovery: test-backstop-config.mjs absent from both test-all exclusion sets",
    !runner.includes("test-backstop-config.mjs"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
