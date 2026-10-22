import {getEffectiveConfigForTest, renderConfigShow} from "./config-show.mjs";
import {DEFAULTS} from "./config-layout.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`);
  }
}

function assertContains(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${message}\n  Expected to contain: ${needle}\n  Actual: ${haystack}`);
  }
}

function assertNotContains(haystack, needle, message) {
  if (haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${message}\n  Expected NOT to contain: ${needle}\n  Actual: ${haystack}`);
  }
}

// Test 1: Default-only setting is shown and marked "default"
console.log("Test 1: Default-only setting marked as default");
{
  const partialConfig = {}; // Empty config - all defaults
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "project.planning_framework"});
  
  assertContains(output, 'project.planning_framework: "standalone" [default]', "Default planning_framework should be marked [default]");
  console.log("  PASS");
}

// Test 2: File value is marked "from config.json"
console.log("Test 2: File value marked as from config.json");
{
  const partialConfig = {
    project: {
      planning_framework: "speckit"
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "project.planning_framework"});
  
  assertContains(output, 'project.planning_framework: "speckit" [from config.json]', "Custom planning_framework should be marked [from config.json]");
  console.log("  PASS");
}

// Test 3: Nested object with mixed default and file values
console.log("Test 3: Nested object with mixed sources");
{
  const partialConfig = {
    caps: {
      planner: {
        max_turns: 50 // Override only max_turns
      }
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "caps.planner"});
  
  assertContains(output, "caps.planner.max_turns: 50 [from config.json]", "Overridden max_turns should be marked [from config.json]");
  assertContains(output, `caps.planner.max_tokens: ${DEFAULTS.caps.planner.max_tokens} [default]`, "Default max_tokens should be marked [default]");
  assertContains(output, `caps.planner.extra_sessions: ${DEFAULTS.caps.planner.extra_sessions} [default]`, "Default extra_sessions should be marked [default]");
  assertContains(output, `caps.planner.wrap_up_at_tokens: ${DEFAULTS.caps.planner.wrap_up_at_tokens} [default]`, "Default wrap_up_at_tokens should be marked [default]");
  console.log("  PASS");
}

// Test 4: Array values - default array
console.log("Test 4: Default array marked as default");
{
  const partialConfig = {};
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "tests.gate_commands"});
  
  assertContains(output, "tests.gate_commands: [] [default]", "Default empty array should be marked [default]");
  console.log("  PASS");
}

// Test 5: Array values - overridden array
console.log("Test 5: Overridden array marked as from config.json");
{
  const partialConfig = {
    tests: {
      gate_commands: ["npm test", "npm run lint"]
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "tests.gate_commands"});
  
  assertContains(output, 'tests.gate_commands: ["npm test", "npm run lint"] [from config.json]', "Custom array should be marked [from config.json]");
  console.log("  PASS");
}

// Test 6: Null value handling
console.log("Test 6: Null value handling");
{
  const partialConfig = {
    runtime: {
      wsl_distro: null
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "runtime.wsl_distro"});
  
  assertContains(output, "runtime.wsl_distro: null [from config.json]", "A key written in the file is marked from config.json even when the value equals the default");
  console.log("  PASS");
}

// Test 7: Boolean values
console.log("Test 7: Boolean values");
{
  const partialConfig = {
    workflow: {
      plan_review: false
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "workflow.plan_review"});
  
  assertContains(output, "workflow.plan_review: false [from config.json]", "Overridden boolean should be marked [from config.json]");
  
  // Test default boolean
  const partialConfig2 = {};
  const effectiveConfig2 = getEffectiveConfigForTest(partialConfig2);
  const output2 = renderConfigShow(effectiveConfig2, {showOnly: "workflow.plan_review"});
  
  assertContains(output2, "workflow.plan_review: true [default]", "Default boolean should be marked [default]");
  console.log("  PASS");
}

// Test 8: Number values
console.log("Test 8: Number values");
{
  const partialConfig = {
    time_limits: {
      call_backstop_minutes: 90
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "time_limits.call_backstop_minutes"});
  
  assertContains(output, "time_limits.call_backstop_minutes: 90 [from config.json]", "Overridden number should be marked [from config.json]");
  console.log("  PASS");
}

// Test 9: Object with nested structure (advanced.capabilities)
console.log("Test 9: Nested object structure");
{
  const partialConfig = {
    advanced: {
      capabilities: {
        legacy_text_inference: true
      }
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "advanced.capabilities"});
  
  assertContains(output, "advanced.capabilities.legacy_text_inference: true [from config.json]", "Overridden nested boolean should be marked [from config.json]");
  assertContains(output, "advanced.capabilities.project_defaults: [] [default]", "Default nested array should be marked [default]");
  assertContains(output, "advanced.capabilities.role_requirements: {} [default]", "Default nested object should be marked [default]");
  assertContains(output, "advanced.capabilities.safety_denied: [] [default]", "Default nested array should be marked [default]");
  console.log("  PASS");
}

// Test 10: Role configuration with fallbacks
console.log("Test 10: Role configuration with fallbacks");
{
  const partialConfig = {
    roles: {
      planner: {
        cli: "claude",
        model: "opus",
        reasoning: "high",
        fallbacks: [
          {cli: "opencode", model: "sonnet"}
        ]
      }
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "roles.planner"});
  
  assertContains(output, 'roles.planner.cli: "claude" [from config.json]', "Custom cli should be marked [from config.json]");
  assertContains(output, 'roles.planner.model: "opus" [from config.json]', "Custom model should be marked [from config.json]");
  assertContains(output, 'roles.planner.reasoning: "high" [from config.json]', "Custom reasoning should be marked [from config.json]");
  assertContains(output, 'roles.planner.variant: "" [default]', "Default variant should be marked [default]");
  assertContains(output, "roles.planner.resume_session: true [default]", "Default resume_session should be marked [default]");
  console.log("  PASS");
}

// Test 11: Full config render (sanity check)
console.log("Test 11: Full config render produces output");
{
  const partialConfig = {
    project: {
      planning_framework: "gsd"
    },
    caps: {
      implementer: {
        max_turns: 60
      }
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig);
  
  assert(output.length > 1000, "Full config output should be substantial");
  assertContains(output, 'project.planning_framework: "gsd" [from config.json]', "Should contain overridden value");
  assertContains(output, "caps.implementer.max_turns: 60 [from config.json]", "Should contain overridden cap");
  assertContains(output, "caps.implementer.max_tokens: 180000 [default]", "Should contain default cap");
  console.log("  PASS");
}

// Test 12: A file value equal to the default is still marked from config.json
console.log("Test 12: File value equal to default marked as from config.json");
{
  const partialConfig = {
    project: {
      planning_framework: DEFAULTS.project.planning_framework
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig, {showOnly: "project.planning_framework"});

  assertContains(output, `project.planning_framework: "${DEFAULTS.project.planning_framework}" [from config.json]`, "Explicit default value should be marked [from config.json]");
  console.log("  PASS");
}

// Test 13: Legacy names resolve to their v4 key and are not shown as raw sections
console.log("Test 13: Legacy names resolve to v4 keys");
{
  const partialConfig = {
    policy: {
      per_task_max_turns: 77
    },
    roles: {
      planner: {
        adapter: "opencode",
        resume: false
      }
    }
  };
  const effectiveConfig = getEffectiveConfigForTest(partialConfig);
  const output = renderConfigShow(effectiveConfig);

  assertContains(output, "caps.implementer.max_turns: 77 [from config.json]", "policy.per_task_max_turns should show under caps.implementer.max_turns");
  assertContains(output, 'roles.planner.cli: "opencode" [from config.json]', "roles.<role>.adapter should show under roles.<role>.cli");
  assertContains(output, "roles.planner.resume_session: false [from config.json]", "roles.<role>.resume should show under roles.<role>.resume_session");
  assertNotContains(output, "policy.per_task_max_turns", "Raw legacy policy section should not be listed");
  assertNotContains(output, "roles.planner.adapter", "Raw legacy adapter key should not be listed");
  console.log("  PASS");
}

// Test 14: --path matches only on dot boundaries
console.log("Test 14: --path uses dot-boundary matching");
{
  const effectiveConfig = getEffectiveConfigForTest({});

  const capsPlan = renderConfigShow(effectiveConfig, {showOnly: "caps.plan"});
  assertNotContains(capsPlan, "caps.planner.", "caps.plan must not match caps.planner");
  assertNotContains(capsPlan, "caps.plan_reviewer.", "caps.plan must not match caps.plan_reviewer");

  const capsPlanner = renderConfigShow(effectiveConfig, {showOnly: "caps.planner"});
  assertContains(capsPlanner, "caps.planner.max_turns", "Exact path should be shown");

  const planner = renderConfigShow(effectiveConfig, {showOnly: "roles.planner"});
  assertContains(planner, "roles.planner.cli", "roles.planner should be shown");
  assertNotContains(planner, "roles.plannerX", "roles.planner must not match roles.plannerX");

  const planReviewer = renderConfigShow(effectiveConfig, {showOnly: "caps.plan_reviewer"});
  assertNotContains(planReviewer, "caps.planner.", "caps.plan_reviewer must not match caps.planner");
  assertContains(planReviewer, "caps.plan_reviewer.max_turns", "Requested path should be shown");
  console.log("  PASS");
}

console.log("\n✓ All tests passed!");