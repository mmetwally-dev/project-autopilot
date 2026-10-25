#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {validateConfigForSave, validateExecutionConfig, validatePolicyConfig} from "./config-validation.mjs";
import {resolveFinalReviewFixRounds, FINAL_REVIEW_FIX_ROUNDS_DEFAULT} from "./per-task-budget.mjs";

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-validation-"));
tempDirs.add(temporary);
const binary = process.platform === "win32" ? path.join(temporary, "fake-cli.cmd") : path.join(temporary, "fake-cli");
if (process.platform === "win32") {
  fs.writeFileSync(binary, '@echo off\r\nif "%1"=="--help" (echo --model MODEL --effort LEVEL --resume-last) else (echo ok)\r\n');
} else {
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--model MODEL --effort LEVEL --resume-last"; else echo ok; fi\n');
  fs.chmodSync(binary, 0o755);
}
const roles = Object.fromEntries(["planner", "plan_reviewer", "implementer", "code_reviewer", "verifier"].map(role => [role, {adapter: "fake", model: role === "planner" ? "x-model" : "", reasoning: role === "planner" ? "high" : "", variant: "", resume: true}]));
const fake = {binary, probe: ["--help"], write: ["run"], read_only: ["plan"], model_flag: "--model", effort_flag: "--effort", variant_flag: null, resume_last: ["--resume-last"], model_discovery: "manual"};
const result = await validateConfigForSave({roles, agents: {fake}, capabilities: {certification: {receipt_ttl_days: 30}}});
if (!result.valid) throw new Error(`Unexpected validation failure: ${JSON.stringify(result)}`);
if (!result.warnings.some(warning => warning.includes("manual selection is unverified"))) throw new Error("Expected non-live validation warning");
const invalidTtl = await validateConfigForSave({roles, agents: {fake}, capabilities: {certification: {receipt_ttl_days: 7}}});
if (invalidTtl.valid || !invalidTtl.errors.some(error => error.includes("fixed at 30"))) throw new Error("Expected fixed receipt TTL validation");

// TASK-19 Phase 5: the first validated policy.* fields.
const policyCases = [
  ["absent is valid", {}, true],
  ["valid timeout below relay", {per_task_timeout_ms: 1000, relay_timeout_ms: 2000}, true],
  ["zero timeout rejected", {per_task_timeout_ms: 0}, false],
  ["non-integer timeout rejected", {per_task_timeout_ms: "1000"}, false],
  ["timeout equal to relay rejected", {per_task_timeout_ms: 2000, relay_timeout_ms: 2000}, false],
  ["timeout above relay rejected", {per_task_timeout_ms: 3000, relay_timeout_ms: 2000}, false],
  ["timeout above the implicit relay default rejected", {per_task_timeout_ms: 250 * 60 * 1000}, false],
  ["timeout below the implicit relay default accepted", {per_task_timeout_ms: 30 * 60 * 1000}, true],
  ["zero turns rejected", {per_task_max_turns: 0}, false],
  ["non-integer turns rejected", {per_task_max_turns: 1.5}, false],
  ["valid turns accepted", {per_task_max_turns: 40}, true],
  ["zero token ceiling rejected", {per_task_max_tokens: 0}, false],
  ["non-integer token ceiling rejected", {per_task_max_tokens: 1.5}, false],
  ["valid token ceiling accepted", {per_task_max_tokens: 10000000}, true],
  ["zero continuation allowance rejected", {continuation_allowance: 0}, false],
  ["non-integer continuation allowance rejected", {continuation_allowance: 2.5}, false],
  ["valid continuation allowance accepted", {continuation_allowance: 3}, true],
  ["handoff below floor rejected", {handoff_max_chars: 499}, false],
  ["handoff at floor accepted", {handoff_max_chars: 500}, true],
  ["handoff default accepted", {handoff_max_chars: 2000}, true],
  ["non-integer handoff rejected", {handoff_max_chars: 800.5}, false],
  ["note below floor rejected", {handoff_note_max_chars: 999}, false],
  ["note at floor accepted", {handoff_note_max_chars: 1000}, true],
  ["note default accepted", {handoff_note_max_chars: 4000}, true],
  ["non-integer note rejected", {handoff_note_max_chars: 1500.5}, false],
  ["wrap-up default accepted", {handoff_wrapup_tokens: 160000}, true],
  ["wrap-up below the ceiling accepted", {handoff_wrapup_tokens: 60000}, true],
  ["wrap-up at the ceiling rejected", {handoff_wrapup_tokens: 180000}, false],
  ["wrap-up above the ceiling rejected", {handoff_wrapup_tokens: 200000, per_task_max_tokens: 180000}, false],
  ["wrap-up below a custom ceiling accepted", {handoff_wrapup_tokens: 60000, per_task_max_tokens: 100000}, true],
  ["wrap-up at a custom ceiling rejected", {handoff_wrapup_tokens: 100000, per_task_max_tokens: 100000}, false],
  ["zero wrap-up rejected", {handoff_wrapup_tokens: 0}, false],
  ["non-integer wrap-up rejected", {handoff_wrapup_tokens: 160000.5}, false],
  ["no-progress default accepted", {no_progress_generations: 2}, true],
  ["no-progress 1 accepted", {no_progress_generations: 1}, true],
  ["zero no-progress rejected", {no_progress_generations: 0}, false],
  ["non-integer no-progress rejected", {no_progress_generations: 1.5}, false],
  // Mission 051 Phase 1 task 1.1: final-review fix rounds. Absent/default
  // accepted; when present must be a positive integer.
  ["fix-rounds default accepted", {final_review_fix_rounds: 2}, true],
  ["fix-rounds 1 accepted", {final_review_fix_rounds: 1}, true],
  ["fix-rounds 3 accepted", {final_review_fix_rounds: 3}, true],
  ["zero fix-rounds rejected", {final_review_fix_rounds: 0}, false],
  ["negative fix-rounds rejected", {final_review_fix_rounds: -1}, false],
  ["non-integer fix-rounds rejected", {final_review_fix_rounds: 1.5}, false],
  ["string fix-rounds rejected", {final_review_fix_rounds: "2"}, false],
  // Backlog #41 (TASK-35): idle-hang watchdog. Absent/0 accepted; must be a
  // non-negative integer strictly below the effective per-task deadline.
  ["idle-hang absent accepted", {}, true],
  ["idle-hang 0 (off) accepted", {idle_hang_ms: 0}, true],
  ["idle-hang default accepted", {idle_hang_ms: 600000}, true],
  ["idle-hang short window accepted", {idle_hang_ms: 3000}, true],
  ["idle-hang negative rejected", {idle_hang_ms: -1}, false],
  ["idle-hang non-integer rejected", {idle_hang_ms: 3000.5}, false],
  ["idle-hang non-number rejected", {idle_hang_ms: "3000"}, false],
  ["idle-hang equal to per-task deadline rejected", {idle_hang_ms: 30 * 60 * 1000, per_task_timeout_ms: 30 * 60 * 1000}, false],
  ["idle-hang above per-task deadline rejected", {idle_hang_ms: 31 * 60 * 1000, per_task_timeout_ms: 30 * 60 * 1000}, false],
  ["idle-hang below per-task deadline accepted", {idle_hang_ms: 600000, per_task_timeout_ms: 30 * 60 * 1000}, true],
  ["idle-hang above the implicit default deadline rejected", {idle_hang_ms: 61 * 60 * 1000}, false],
];
for (const [label, policy, expected] of policyCases) {
  const r = validatePolicyConfig(policy);
  if (r.valid !== expected) throw new Error(`policy ${label}: expected valid=${expected}, got ${JSON.stringify(r)}`);
}
const equalTimeout = validatePolicyConfig({per_task_timeout_ms: 2000, relay_timeout_ms: 2000});
if (!equalTimeout.errors.some(e => e.includes("2000") && e.includes("per_task_timeout_ms") && e.includes("relay_timeout_ms"))) {
  throw new Error(`Expected the timeout-vs-relay rejection to name both values and the fix, got ${JSON.stringify(equalTimeout)}`);
}
// The invariant must hold against the EFFECTIVE relay timeout (the 200-minute
// runtime default when relay_timeout_ms is absent), not only an explicitly
// written field.
const implicitRelay = validatePolicyConfig({per_task_timeout_ms: 250 * 60 * 1000});
if (implicitRelay.valid || !implicitRelay.errors.some(e => e.includes("default relay timeout") && e.includes(String(200 * 60 * 1000)))) {
  throw new Error(`Expected the implicit-relay-default rejection to name the default, got ${JSON.stringify(implicitRelay)}`);
}
const badPolicy = await validateConfigForSave({roles, agents: {fake}, capabilities: {}, policy: {per_task_timeout_ms: 0}});
if (badPolicy.valid || !badPolicy.errors.some(e => e.includes("per_task_timeout_ms"))) {
  throw new Error(`Expected validateConfigForSave to surface the policy rejection, got ${JSON.stringify(badPolicy)}`);
}

// Mission 031 Phase 1 task 1.4: validate policy.caps per-role entries
const capsCases = [
  ["valid caps block for all review roles", {
    caps: {
      planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1},
      plan_reviewer: {max_turns: 18, max_tokens: 150000, extra_sessions: 2},
      code_reviewer: {max_turns: 22, max_tokens: 150000, extra_sessions: 0},
      verifier: {max_turns: 15, max_tokens: 150000, extra_sessions: 3},
    }
  }, true],
  ["valid caps with wrap_up_tokens_threshold", {
    caps: {
      planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: 180000},
      plan_reviewer: {max_turns: 18, max_tokens: 150000, extra_sessions: 2, wrap_up_tokens_threshold: 135000},
    }
  }, true],
  ["valid caps with partial roles", {
    caps: {
      planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1},
    }
  }, true],
  ["non-integer max_turns rejected", {
    caps: {planner: {max_turns: 1.5, max_tokens: 400000, extra_sessions: 1}}
  }, false],
  ["zero max_turns rejected", {
    caps: {planner: {max_turns: 0, max_tokens: 400000, extra_sessions: 1}}
  }, false],
  ["negative max_turns rejected", {
    caps: {planner: {max_turns: -1, max_tokens: 400000, extra_sessions: 1}}
  }, false],
  ["missing max_turns rejected", {
    caps: {planner: {max_tokens: 400000, extra_sessions: 1}}
  }, false],
  ["non-integer max_tokens rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 1.5, extra_sessions: 1}}
  }, false],
  ["zero max_tokens rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 0, extra_sessions: 1}}
  }, false],
  ["negative max_tokens rejected", {
    caps: {planner: {max_turns: 20, max_tokens: -100, extra_sessions: 1}}
  }, false],
  ["missing max_tokens rejected", {
    caps: {planner: {max_turns: 20, extra_sessions: 1}}
  }, false],
  ["max_tokens at ceiling rejected", {
    caps: {verifier: {max_turns: 20, max_tokens: 180000, extra_sessions: 1}},
    per_task_max_tokens: 180000
  }, false],
  ["max_tokens above ceiling rejected", {
    caps: {verifier: {max_turns: 20, max_tokens: 200000, extra_sessions: 1}},
    per_task_max_tokens: 180000
  }, false],
  ["stale cumulative 300K verifier rejected under per-turn ceiling", {
    caps: {verifier: {max_turns: 20, max_tokens: 300000, extra_sessions: 1}},
  }, false],
  ["stale cumulative 450K verifier rejected under per-turn ceiling", {
    caps: {verifier: {max_turns: 20, max_tokens: 450000, extra_sessions: 1}},
  }, false],
  ["planner max_tokens above global ceiling accepted", {
    caps: {planner: {max_turns: 22, max_tokens: 200000, extra_sessions: 2}},
  }, true],
  ["planner defaults with wrap-up accepted", {
    caps: {planner: {max_turns: 22, max_tokens: 200000, extra_sessions: 2, wrap_up_tokens_threshold: 180000}},
  }, true],
  ["max_tokens below custom ceiling accepted", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1}},
    per_task_max_tokens: 300000
  }, true],
  ["negative extra_sessions rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 400000, extra_sessions: -1}}
  }, false],
  ["non-integer extra_sessions rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 400000, extra_sessions: 1.5}}
  }, false],
  ["missing extra_sessions rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 400000}}
  }, false],
  ["wrap_up_tokens_threshold at max_tokens rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: 200000}}
  }, false],
  ["wrap_up_tokens_threshold above max_tokens rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: 250000}}
  }, false],
  ["wrap_up_tokens_threshold non-integer rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: 180000.5}}
  }, false],
  ["wrap_up_tokens_threshold zero rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: 0}}
  }, false],
  ["wrap_up_tokens_threshold negative rejected", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: -100}}
  }, false],
  ["wrap_up_tokens_threshold below max_tokens accepted", {
    caps: {planner: {max_turns: 20, max_tokens: 200000, extra_sessions: 1, wrap_up_tokens_threshold: 180000}}
  }, true],
  ["unknown role rejected", {
    caps: {implementer: {max_turns: 20, max_tokens: 400000, extra_sessions: 1}}
  }, false],
  ["unknown role 'unknown' rejected", {
    caps: {unknown: {max_turns: 20, max_tokens: 400000, extra_sessions: 1}}
  }, false],
  ["non-object caps value rejected", {
    caps: "not-an-object"
  }, false],
  ["array caps value rejected", {
    caps: [{max_turns: 20, max_tokens: 400000, extra_sessions: 1}]
  }, false],
  ["null caps value rejected", {
    caps: null
  }, false],
  ["non-object role caps rejected", {
    caps: {planner: "not-an-object"}
  }, false],
  ["array role caps rejected", {
    caps: {planner: [{max_turns: 20, max_tokens: 400000, extra_sessions: 1}]}
  }, false],
];
for (const [label, policy, expected] of capsCases) {
  const r = validatePolicyConfig(policy);
  if (r.valid !== expected) throw new Error(`policy.caps ${label}: expected valid=${expected}, got ${JSON.stringify(r)}`);
}

// Mission 051 Phase 1 task 1.1: the fix-round resolver. Unset config resolves
// to the default (2); valid operator values pass through; invalid values
// degrade to the default (validation rejects them at load; this covers
// hand-built policies that bypass validation).
if (FINAL_REVIEW_FIX_ROUNDS_DEFAULT !== 2) throw new Error(`FINAL_REVIEW_FIX_ROUNDS_DEFAULT !== 2: ${FINAL_REVIEW_FIX_ROUNDS_DEFAULT}`);
if (resolveFinalReviewFixRounds({}) !== 2) throw new Error("unset config must resolve to 2");
if (resolveFinalReviewFixRounds() !== 2) throw new Error("absent policy must resolve to 2");
if (resolveFinalReviewFixRounds({final_review_fix_rounds: 3}) !== 3) throw new Error("operator value 3 not preserved");
if (resolveFinalReviewFixRounds({final_review_fix_rounds: 0}) !== 2) throw new Error("zero must degrade to 2");
if (resolveFinalReviewFixRounds({final_review_fix_rounds: 1.5}) !== 2) throw new Error("non-integer must degrade to 2");

// Backlog #15 (089 Phase 1 task 1.1): windows-compatibility is valid for
// SpecKit and standalone; gsd and null/undetermined are rejected clearly.
const compatExecution = {runtime_mode: "windows-compatibility", wsl_distro: null};
const compatSpeckit = validateExecutionConfig(compatExecution, "speckit");
if (!compatSpeckit.valid) throw new Error(`compat speckit must validate: ${JSON.stringify(compatSpeckit)}`);
const compatStandalone = validateExecutionConfig(compatExecution, "standalone");
if (!compatStandalone.valid) throw new Error(`compat standalone must validate: ${JSON.stringify(compatStandalone)}`);
const compatGsd = validateExecutionConfig(compatExecution, "gsd");
if (compatGsd.valid || !compatGsd.errors.some(e => e.includes("windows-compatibility") && e.includes("'gsd'"))) throw new Error(`compat gsd must reject clearly: ${JSON.stringify(compatGsd)}`);
const compatNull = validateExecutionConfig(compatExecution, null);
if (compatNull.valid || !compatNull.errors.some(e => e.includes("windows-compatibility"))) throw new Error(`compat null framework must reject clearly: ${JSON.stringify(compatNull)}`);
const compatUndefined = validateExecutionConfig(compatExecution, undefined);
if (compatUndefined.valid || !compatUndefined.errors.some(e => e.includes("windows-compatibility"))) throw new Error(`compat undetermined framework must reject clearly: ${JSON.stringify(compatUndefined)}`);

console.log("config validation tests passed");
