// Test for one-release old-name compatibility in toRuntimeConfig.
// Feeds a v4 layout with legacy keys and asserts the runtime shape resolves correctly.

import { toRuntimeConfig, migrateTimeLimitNames } from "./config-layout.mjs";
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

// Test 1: v4 caps.planner wins over legacy policy.caps.planner
test("v4 caps.planner wins over legacy policy.caps.planner", () => {
  const layout = {
    caps: { planner: { max_turns: 10, max_tokens: 50000 } },
    policy: { caps: { planner: { max_turns: 20, max_tokens: 100000, extra_sessions: 3, wrap_up_tokens_threshold: 90000 } } },
  };
  const rt = toRuntimeConfig(layout);
  // v4 caps.planner should win over legacy policy.caps.planner
  deepEqual(rt.policy.caps.planner.max_turns, 10);
  deepEqual(rt.policy.caps.planner.max_tokens, 50000);
});

// Test 2: Legacy policy.caps.<role> used when v4 caps.<role> absent
test("legacy policy.caps.plan_reviewer used when caps.plan_reviewer absent", () => {
  const layout = {
    policy: { caps: { plan_reviewer: { max_turns: 25, max_tokens: 120000, extra_sessions: 1, wrap_up_tokens_threshold: 110000 } } },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.caps.plan_reviewer.max_turns, 25);
  deepEqual(rt.policy.caps.plan_reviewer.max_tokens, 120000);
  deepEqual(rt.policy.caps.plan_reviewer.extra_sessions, 1);
  deepEqual(rt.policy.caps.plan_reviewer.wrap_up_tokens_threshold, 110000);
});

// Test 3: Legacy policy.per_task_max_* fallback for implementer
test("legacy policy.per_task_max_turns/tokens used when caps.implementer absent", () => {
  const layout = {
    policy: { per_task_max_turns: 50, per_task_max_tokens: 200000 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.per_task_max_turns, 50);
  deepEqual(rt.policy.per_task_max_tokens, 200000);
});

// Test 4: v4 caps.implementer wins over legacy policy.per_task_max_*
test("v4 caps.implementer wins over legacy policy.per_task_max_*", () => {
  const layout = {
    caps: { implementer: { max_turns: 30, max_tokens: 150000 } },
    policy: { per_task_max_turns: 50, per_task_max_tokens: 200000 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.per_task_max_turns, 30);
  deepEqual(rt.policy.per_task_max_tokens, 150000);
});

// Test 5: Legacy policy.continuation_allowance fallback
test("legacy policy.continuation_allowance used when caps.implementer.extra_sessions and retries.extra_sessions_per_task absent", () => {
  const layout = {
    policy: { continuation_allowance: 7 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.continuation_allowance, 7);
});

// Test 6: Legacy policy.free_model_turns_cap and freeModelAutoFallback
test("legacy free_model_turns_cap and freeModelAutoFallback fallback", () => {
  const layout = {
    policy: { free_model_turns_cap: 99 },
    freeModelAutoFallback: false,
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.free_model_turns_cap, 99);
  deepEqual(rt.freeModelAutoFallback, false);
});

// Test 7: Legacy policy.failure_budgets.* fallback
test("legacy policy.failure_budgets.* fallback", () => {
  const layout = {
    policy: {
      failure_budgets: {
        implementationFailureBudget: 5,
        verificationFailureBudget: 6,
        adapterRetryBudget: 7,
        infrastructureRetryBudget: 8,
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.failure_budgets.implementationFailureBudget, 5);
  deepEqual(rt.policy.failure_budgets.verificationFailureBudget, 6);
  deepEqual(rt.policy.failure_budgets.adapterRetryBudget, 7);
  deepEqual(rt.policy.failure_budgets.infrastructureRetryBudget, 8);
});

// Test 8: Legacy policy.max_plan_revisions, no_progress_generations, final_review_fix_rounds
test("legacy policy.max_plan_revisions/no_progress_generations/final_review_fix_rounds fallback", () => {
  const layout = {
    policy: {
      max_plan_revisions: 10,
      no_progress_generations: 3,
      final_review_fix_rounds: 4,
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.max_plan_revisions, 10);
  deepEqual(rt.policy.no_progress_generations, 3);
  deepEqual(rt.policy.final_review_fix_rounds, 4);
});

// Test 9: Legacy policy.backstop_raw_tokens fallback
test("legacy policy.backstop_raw_tokens fallback", () => {
  const layout = {
    policy: { backstop_raw_tokens: 7000000 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.backstop_raw_tokens, 7000000);
});

// Test 10: Legacy policy.relay_timeout_ms fallback
test("legacy policy.relay_timeout_ms fallback", () => {
  const layout = {
    policy: { relay_timeout_ms: 5000000 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.relay_timeout_ms, 5000000);
});

// Test 11: Legacy policy.role_timeout_ms fallback
test("legacy policy.role_timeout_ms fallback", () => {
  const layout = {
    policy: { role_timeout_ms: { default: 300000, verifier: 900000 } },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.role_timeout_ms.default, 300000);
  deepEqual(rt.policy.role_timeout_ms.verifier, 900000);
  deepEqual(rt.policy.per_task_timeout_ms, 300000);
});

// Test 12: Legacy policy.role_deadline_floor_ms, idle_hang_ms, first_output_ms, max_silence_ms, retry_delay_ms
test("legacy policy time limit fallbacks", () => {
  const layout = {
    policy: {
      role_deadline_floor_ms: 60000,
      idle_hang_ms: 120000,
      first_output_ms: 90000,
      max_silence_ms: 180000,
      retry_delay_ms: 30000,
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.role_deadline_floor_ms, 60000);
  deepEqual(rt.policy.idle_hang_ms, 120000);
  deepEqual(rt.policy.first_output_ms, 90000);
  deepEqual(rt.policy.max_silence_ms, 180000);
  deepEqual(rt.policy.retry_delay_ms, 30000);
});

// Test 13: Legacy policy.handoff_* and checkpoint_* fallbacks
test("legacy policy.handoff_*/checkpoint_* fallbacks", () => {
  const layout = {
    policy: {
      handoff_max_chars: 3000,
      handoff_note_max_chars: 5000,
      handoff_wrapup_tokens: 170000,
      fallback_retry_primary_minutes: 15,
      checkpoint_after_task: false,
      checkpoint_after_phase: false,
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.handoff_max_chars, 3000);
  deepEqual(rt.policy.handoff_note_max_chars, 5000);
  deepEqual(rt.policy.handoff_wrapup_tokens, 170000);
  deepEqual(rt.policy.fallback_retry_primary_minutes, 15);
  deepEqual(rt.policy.checkpoint_after_task, false);
  deepEqual(rt.policy.checkpoint_after_phase, false);
});

// Test 14: Legacy policy.fail_closed_on_relay_violation fallback
test("legacy policy.fail_closed_on_relay_violation fallback", () => {
  const layout = {
    policy: { fail_closed_on_relay_violation: false },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.fail_closed_on_relay_violation, false);
});

// Test 15: Legacy execution.runtime_mode / wsl_distro fallback
test("legacy execution.runtime_mode/wsl_distro fallback", () => {
  const layout = {
    execution: { runtime_mode: "windows-compat", wsl_distro: "Debian" },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.execution.runtime_mode, "windows-compat");
  deepEqual(rt.execution.wsl_distro, "Debian");
});

// Test 16: Legacy workflow camelCase keys fallback
test("legacy workflow camelCase fallback", () => {
  const layout = {
    workflow: {
      plan_review_convergence: false,
      pauseForPlanApproval: true,
      autoApprovePlan: false,
      autoApproveSpec: true,
      parallelIndependentTasks: true,
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.workflow.plan_review_convergence, false);
  deepEqual(rt.workflow.pauseForPlanApproval, true);
  deepEqual("autoApprovePlan" in rt.workflow, false);
  deepEqual(rt.workflow.autoApproveSpec, true);
  deepEqual(rt.workflow.parallelIndependentTasks, true);
});

// Test 17: Legacy workflow.relaySafety.* fallback
test("legacy workflow.relaySafety.* fallback", () => {
  const layout = {
    workflow: {
      relaySafety: {
        block_git_commit_push: false,
        verify_read_only_by_snapshot: false,
        capture_touched_files: false,
        persist_role_sessions: false,
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.workflow.relaySafety.block_git_commit_push, false);
  deepEqual(rt.workflow.relaySafety.verify_read_only_by_snapshot, false);
  deepEqual(rt.workflow.relaySafety.capture_touched_files, false);
  deepEqual(rt.workflow.relaySafety.persist_role_sessions, false);
});

// Test 18: Legacy gates.* fallback
test("legacy gates.* fallback", () => {
  const layout = {
    gates: {
      commands: ["npm test"],
      network_isolation: true,
      env_allowlist: ["FOO"],
      require_reviewer: false,
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.gates.commands, ["npm test"]);
  deepEqual(rt.gates.network_isolation, true);
  deepEqual(rt.gates.env_allowlist, ["FOO"]);
  deepEqual(rt.gates.require_reviewer, false);
});

// Test 19: Legacy roles.<r>.adapter / resume fallback
test("legacy roles.*.adapter/resume fallback", () => {
  const layout = {
    roles: {
      planner: { adapter: "claude", model: "opus", resume: false },
      implementer: { adapter: "opencode", model: "free-model", resume: true },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.roles.planner.adapter, "claude");
  deepEqual(rt.roles.planner.resume, false);
  deepEqual(rt.roles.implementer.adapter, "opencode");
  deepEqual(rt.roles.implementer.resume, true);
});

// Test 20: v4 roles.<r>.cli / resume_session wins over legacy
test("v4 roles.*.cli/resume_session wins over legacy adapter/resume", () => {
  const layout = {
    roles: {
      planner: { cli: "opencode", model: "free", resume_session: true, adapter: "claude", resume: false },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.roles.planner.adapter, "opencode");
  deepEqual(rt.roles.planner.resume, true);
});

// Test 21: Legacy planning.speckit / planning.gsd fallback
test("legacy planning.speckit/gsd fallback", () => {
  const layout = {
    planning: {
      speckit: { workflow_file: ".specify/workflow.yml", task_candidates: ["tasks.md"] },
      gsd: { phase_root: ".planning/phases", parallelization: { enabled: true } },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.planning.speckit.workflow_file, ".specify/workflow.yml");
  deepEqual(rt.planning.speckit.task_candidates, ["tasks.md"]);
  deepEqual(rt.planning.gsd.phase_root, ".planning/phases");
  deepEqual(rt.planning.gsd.parallelization.enabled, true);
});

// Test 22: Legacy capabilities.* fallback
test("legacy capabilities.* fallback", () => {
  const layout = {
    capabilities: {
      project_defaults: ["read"],
      role_requirements: { implementer: ["write"] },
      safety_denied: ["delete"],
      legacy_text_inference: true,
      verification: { browser: "playwright", require_browser: "always" },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.capabilities.project_defaults, ["read"]);
  deepEqual(rt.capabilities.role_requirements.implementer, ["write"]);
  deepEqual(rt.capabilities.safety_denied, ["delete"]);
  deepEqual(rt.capabilities.legacy_text_inference, true);
  deepEqual(rt.capabilities.verification.browser, "playwright");
  deepEqual(rt.capabilities.verification.require_browser, "always");
});

// Test 23: Mixed v4 and legacy - v4 wins (merged policy keys)
test("mixed v4 and legacy - v4 wins", () => {
  const layout = {
    caps: { planner: { max_turns: 100 } },
    policy: { caps: { planner: { max_turns: 200 } }, relay_timeout_ms: 2000000 },
    time_limits: { call_backstop_minutes: 100 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.caps.planner.max_turns, 100);
  deepEqual(rt.policy.relay_timeout_ms, 100 * 60 * 1000); // 100 minutes in ms
});

// Test 23b: the old `mission_timeout_minutes` name is still read (one release)
test("old mission_timeout_minutes name still maps to the call backstop", () => {
  const rt = toRuntimeConfig({ time_limits: { mission_timeout_minutes: 125 } });
  deepEqual(rt.policy.relay_timeout_ms, 125 * 60 * 1000);
  // The new name wins when both are present.
  const both = toRuntimeConfig({ time_limits: { call_backstop_minutes: 200, mission_timeout_minutes: 125 } });
  deepEqual(both.policy.relay_timeout_ms, 200 * 60 * 1000);
});

// Test 23c: migration and `migrateTimeLimitNames` rewrite the old name.
test("migration rewrites mission_timeout_minutes to call_backstop_minutes", () => {
  const input = {schema_version: "4.0", time_limits: {mission_timeout_minutes: 125}};
  const result = migrateConfig(input);
  assert.equal(result.changed, true);
  assert.equal(result.layout.time_limits.call_backstop_minutes, 125);
  assert.equal("mission_timeout_minutes" in result.layout.time_limits, false);
  assert.equal(input.time_limits.mission_timeout_minutes, 125, "input must not be mutated");
  // New name wins when both are present.
  const renamed = migrateTimeLimitNames({time_limits: {call_backstop_minutes: 200, mission_timeout_minutes: 125}});
  assert.deepEqual(renamed.layout, {time_limits: {call_backstop_minutes: 200}});
});

// Test 24: Legacy fallback adapter in fallback entry (roles.*.fallbacks[].adapter)
test("legacy fallback adapter in roles.*.fallbacks[].adapter resolves", () => {
  const layout = {
    roles: {
      planner: {
        cli: "opencode",
        fallbacks: [{ adapter: "claude", model: "opus" }],
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.roles.planner.fallbacks[0].adapter, "claude");
});

// Test 25: Legacy fallback adapter in escalation_model
test("legacy escalation_model.adapter resolves", () => {
  const layout = {
    roles: {
      planner: {
        cli: "opencode",
        escalation_model: { adapter: "claude", model: "opus" },
      },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.roles.planner.escalation_model.adapter, "claude");
});

// Test 26: Legacy policy.require_human_commit fallback
test("legacy policy.require_human_commit fallback", () => {
  const layout = {
    policy: { require_human_commit: false },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.require_human_commit, false);
});

// Test 27: v4 workflow.commit_by_human wins over legacy policy.require_human_commit
test("v4 workflow.commit_by_human wins over legacy policy.require_human_commit", () => {
  const layout = {
    workflow: { commit_by_human: true },
    policy: { require_human_commit: false },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.require_human_commit, true);
});

// Test 28: Legacy policy.task_size_target_turns fallback
test("legacy policy.task_size_target_turns fallback", () => {
  const layout = {
    policy: { task_size_target_turns: 25 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.task_size_target_turns, 25);
});

// Test 29: v4 caps.task_size_target_turns wins over legacy policy.task_size_target_turns
test("v4 caps.task_size_target_turns wins over legacy policy.task_size_target_turns", () => {
  const layout = {
    caps: { task_size_target_turns: 15 },
    policy: { task_size_target_turns: 25 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.task_size_target_turns, 15);
});

// Test 30: Legacy explicit policy.per_task_timeout_ms fallback
test("legacy explicit policy.per_task_timeout_ms fallback", () => {
  const layout = {
    policy: { per_task_timeout_ms: 1800000 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.per_task_timeout_ms, 1800000);
});

// Test 31: v4 time_limits.role_timeout_minutes.default wins over legacy policy.per_task_timeout_ms
test("v4 time_limits.role_timeout_minutes.default wins over legacy policy.per_task_timeout_ms", () => {
  const layout = {
    time_limits: { role_timeout_minutes: { default: 45 } },
    policy: { per_task_timeout_ms: 1800000 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.per_task_timeout_ms, 45 * 60 * 1000);
});

// Test 32: Unknown legacy policy keys carried through
test("unknown legacy policy keys carried through", () => {
  const layout = {
    policy: { custom_operator_key: "custom_value", another_key: 42 },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.policy.custom_operator_key, "custom_value");
  deepEqual(rt.policy.another_key, 42);
});

// Test 33: Mixed execution section - runtime.mode wins, legacy execution.wsl_distro fills gap
test("mixed execution - v4 runtime.mode wins, legacy execution.wsl_distro fills gap", () => {
  const layout = {
    runtime: { mode: "wsl" },
    execution: { wsl_distro: "Ubuntu" },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.execution.runtime_mode, "wsl");
  deepEqual(rt.execution.wsl_distro, "Ubuntu");
});

// Test 34: Mixed execution section - legacy execution.runtime_mode fills gap when runtime.mode absent
test("mixed execution - legacy execution.runtime_mode fills gap when runtime.mode absent", () => {
  const layout = {
    runtime: { wsl_distro: "Fedora" },
    execution: { runtime_mode: "windows-compat" },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.execution.runtime_mode, "windows-compat");
  deepEqual(rt.execution.wsl_distro, "Fedora");
});

// Test 35: Legacy planning.speckit/gsd merges even when frameworks exists (empty)
test("legacy planning.speckit/gsd merges when frameworks is empty object", () => {
  const layout = {
    frameworks: {},
    planning: {
      speckit: { workflow_file: ".specify/workflow.yml" },
      gsd: { phase_root: ".planning/phases" },
    },
  };
  const rt = toRuntimeConfig(layout);
  deepEqual(rt.planning.speckit.workflow_file, ".specify/workflow.yml");
  deepEqual(rt.planning.gsd.phase_root, ".planning/phases");
});

// Test 36: Legacy planning.speckit/gsd merges missing keys when frameworks has partial data
test("legacy planning.speckit/gsd merges missing keys when frameworks has partial data", () => {
  const layout = {
    frameworks: { speckit: { workflow_file: "custom/workflow.yml" } },
    planning: {
      speckit: { task_candidates: ["legacy-tasks.md"] },
      gsd: { phase_root: ".planning/phases" },
    },
  };
  const rt = toRuntimeConfig(layout);
  // v4 frameworks.speckit.workflow_file wins
  deepEqual(rt.planning.speckit.workflow_file, "custom/workflow.yml");
  // legacy planning.speckit.task_candidates fills gap
  deepEqual(rt.planning.speckit.task_candidates, ["legacy-tasks.md"]);
  // legacy planning.gsd fills gap
  deepEqual(rt.planning.gsd.phase_root, ".planning/phases");
});

console.log("\nAll old-name compatibility tests completed.");