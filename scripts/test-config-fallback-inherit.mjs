// Test for fallback inheritance of reasoning and variant from role (spec addition 5).
// A fallback without reasoning/variant should inherit from the role; explicit values win.

import { toRuntimeConfig } from "./config-layout.mjs";
import { migrateConfig } from "./config-migration.mjs";
import assert from "node:assert";

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function deepEqual(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

// Test 1: Fallback without reasoning/variant inherits from role
test("fallback inherits reasoning and variant from role when not set on fallback", () => {
  const layout = {
    roles: {
      implementer: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { cli: "claude", model: "sonnet" }, // no reasoning/variant
        ],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  const fallback = rt.roles.implementer.fallbacks[0];
  deepEqual(fallback.adapter, "claude");
  deepEqual(fallback.model, "sonnet");
  deepEqual(fallback.reasoning, "high", "fallback should inherit role's reasoning");
  deepEqual(fallback.variant, "beta", "fallback should inherit role's variant");
});

// Test 2: Explicit fallback reasoning/variant wins over role
test("explicit fallback reasoning/variant wins over role values", () => {
  const layout = {
    roles: {
      implementer: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { cli: "claude", model: "sonnet", reasoning: "medium", variant: "stable" },
        ],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  const fallback = rt.roles.implementer.fallbacks[0];
  deepEqual(fallback.reasoning, "medium", "explicit fallback reasoning should win");
  deepEqual(fallback.variant, "stable", "explicit fallback variant should win");
});

// Test 3: Partial override - only reasoning set on fallback
test("fallback with only reasoning set inherits variant from role", () => {
  const layout = {
    roles: {
      planner: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { cli: "claude", model: "sonnet", reasoning: "low" }, // only reasoning set
        ],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  const fallback = rt.roles.planner.fallbacks[0];
  deepEqual(fallback.reasoning, "low", "explicit fallback reasoning should win");
  deepEqual(fallback.variant, "beta", "fallback should inherit role's variant");
});

// Test 4: Partial override - only variant set on fallback
test("fallback with only variant set inherits reasoning from role", () => {
  const layout = {
    roles: {
      verifier: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { cli: "claude", model: "sonnet", variant: "preview" }, // only variant set
        ],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  const fallback = rt.roles.verifier.fallbacks[0];
  deepEqual(fallback.reasoning, "high", "fallback should inherit role's reasoning");
  deepEqual(fallback.variant, "preview", "explicit fallback variant should win");
});

// Test 5: Multiple fallbacks - each inherits independently
test("multiple fallbacks each inherit reasoning/variant from role", () => {
  const layout = {
    roles: {
      code_reviewer: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { cli: "claude", model: "sonnet" },
          { cli: "claude", model: "haiku", reasoning: "none" },
          { cli: "openai", model: "gpt-4o", variant: "preview" },
        ],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  const fallbacks = rt.roles.code_reviewer.fallbacks;
  deepEqual(fallbacks[0].reasoning, "high", "fallback 0 inherits reasoning");
  deepEqual(fallbacks[0].variant, "beta", "fallback 0 inherits variant");
  deepEqual(fallbacks[1].reasoning, "none", "fallback 1 explicit reasoning wins");
  deepEqual(fallbacks[1].variant, "beta", "fallback 1 inherits variant");
  deepEqual(fallbacks[2].reasoning, "high", "fallback 2 inherits reasoning");
  deepEqual(fallbacks[2].variant, "preview", "fallback 2 explicit variant wins");
});

// Test 6: Empty string on fallback should be treated as unset (inherit from role)
test("empty string on fallback is treated as unset, inherits from role", () => {
  const layout = {
    roles: {
      plan_reviewer: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { cli: "claude", model: "sonnet", reasoning: "", variant: "" },
        ],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  const fallback = rt.roles.plan_reviewer.fallbacks[0];
  deepEqual(fallback.reasoning, "high", "empty string treated as unset, inherits role's reasoning");
  deepEqual(fallback.variant, "beta", "empty string treated as unset, inherits role's variant");
});

// Test 7: Migration round-trip - v3 config with role reasoning/variant and fallback without them
// should inherit after migrateConfig -> toRuntimeConfig
test("migration round-trip: v3 role reasoning/variant inherited by fallback without them", () => {
  // Simulate a v3 config (legacy runtime shape) with role reasoning/variant and fallback without them
  const v3Config = {
    schema_version: "3.0",
    roles: {
      implementer: {
        adapter: "claude",
        model: "opus",
        reasoning: "high",
        variant: "beta",
        fallbacks: [
          { adapter: "claude", model: "sonnet" }, // no reasoning/variant
        ],
      },
    },
  };
  const migrated = migrateConfig(v3Config);
  const rt = toRuntimeConfig(migrated.layout);
  const fallback = rt.roles.implementer.fallbacks[0];
  deepEqual(fallback.adapter, "claude");
  deepEqual(fallback.model, "sonnet");
  deepEqual(fallback.reasoning, "high", "migrated fallback should inherit role's reasoning");
  deepEqual(fallback.variant, "beta", "migrated fallback should inherit role's variant");
});

console.log("All tests completed.");