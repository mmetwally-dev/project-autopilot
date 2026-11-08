#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  budgetEscalationDecision,
  formatBudgetEscalationLog,
  budgetEscalationModel,
  implementerModelFor,
  clearBudgetEscalation,
  consumeEscalationFor,
} from "./escalation-model.mjs";
import { recordFailureBudget, failure } from "./failure-contract.mjs";
import { DEFAULTS } from "./config-layout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Unit cases for budgetEscalationDecision:
// limit 5: used 1, 2 → none
assert.equal(
  budgetEscalationDecision({ used: 1, limit: 5, hasEscalationModel: true, alreadySwitched: false }),
  "none",
  "limit 5, used 1 -> none (4 remaining)"
);
assert.equal(
  budgetEscalationDecision({ used: 2, limit: 5, hasEscalationModel: true, alreadySwitched: false }),
  "none",
  "limit 5, used 2 -> none (3 remaining)"
);
// limit 5: used 3 → switch (2 remaining)
assert.equal(
  budgetEscalationDecision({ used: 3, limit: 5, hasEscalationModel: true, alreadySwitched: false }),
  "switch",
  "limit 5, used 3 -> switch (2 remaining)"
);
// limit 5: used 4 with entry → keep
assert.equal(
  budgetEscalationDecision({ used: 4, limit: 5, hasEscalationModel: true, alreadySwitched: true }),
  "keep",
  "limit 5, used 4 with entry -> keep"
);
// no escalation model → none
assert.equal(
  budgetEscalationDecision({ used: 3, limit: 5, hasEscalationModel: false, alreadySwitched: false }),
  "none",
  "no escalation model -> none"
);
// limit 2: used 1 → switch (1 remaining)
assert.equal(
  budgetEscalationDecision({ used: 1, limit: 2, hasEscalationModel: true, alreadySwitched: false }),
  "switch",
  "limit 2, used 1 -> switch (1 remaining)"
);
console.log("PASS 1. budgetEscalationDecision unit cases");

// Test formatBudgetEscalationLog
{
  const log = formatBudgetEscalationLog({
    role: "implementer",
    from: { adapter: "anthropic", model: "claude-haiku" },
    to: { adapter: "anthropic", model: "claude-sonnet" },
    budget: "implementationFailureBudget",
    used: 3,
    limit: 5,
  });
  assert.equal(
    log,
    "escalation: implementer anthropic/claude-haiku → anthropic/claude-sonnet for the last 2 fix rounds before the budget runs out (implementationFailureBudget 3/5)"
  );
}
console.log("PASS formatBudgetEscalationLog formatting");

// 2. State-level test: entry survives consumeEscalationFor and model selection returns escalation model
{
  const config = {
    roles: {
      implementer: {
        adapter: "anthropic",
        model: "claude-haiku",
        escalation_model: {
          adapter: "anthropic",
          model: "claude-sonnet",
        },
      },
      code_reviewer: {
        adapter: "anthropic",
        model: "claude-sonnet",
      },
    },
  };

  const state = {
    budgetEscalations: {
      "standalone:phase-0": {
        role: "implementer",
        from: { adapter: "anthropic", model: "claude-haiku" },
        to: { adapter: "anthropic", model: "claude-sonnet" },
        budget: "implementationFailureBudget",
        used: 3,
        limit: 5,
        at: new Date().toISOString(),
      },
    },
    escalationPending: {
      implementer: {
        scopeKey: "standalone:phase-0",
        to: { adapter: "anthropic", model: "claude-sonnet" },
      },
    },
  };

  // consumeEscalationFor clears escalationPending
  const consumed = consumeEscalationFor(state, "code_reviewer");
  assert.equal(consumed, "implementer", "consumeEscalationFor clears fixer role");
  assert.equal(state.escalationPending, undefined, "escalationPending dropped after reviewer starts");

  // But budgetEscalations entry SURVIVES consumeEscalationFor!
  assert.ok(state.budgetEscalations["standalone:phase-0"], "budgetEscalations entry survived consumeEscalationFor");

  // Model selection still returns the escalation model for this phase scope
  const selectedModel = implementerModelFor(state, config, "standalone:phase-0");
  assert.deepEqual(
    selectedModel,
    { adapter: "anthropic", model: "claude-sonnet" },
    "implementerModelFor returns escalation model while budgetEscalations entry exists"
  );

  // For a different scope without entry, it returns the configured primary model
  const otherScopeModel = implementerModelFor(state, config, "standalone:phase-1");
  assert.equal(otherScopeModel.model, "claude-haiku", "un-escalated scope uses normal model");

  // Clearing the budget escalation drops the entry and model selection reverts to normal
  clearBudgetEscalation(state, "standalone:phase-0");
  assert.equal(state.budgetEscalations, undefined, "budgetEscalations cleared when empty");
  const revertedModel = implementerModelFor(state, config, "standalone:phase-0");
  assert.equal(revertedModel.model, "claude-haiku", "reverts to configured model after clear");
}
// State with one budgetEscalations entry for another phase or phaseIndex past the plan
// must NOT fall back to picking that single entry: only the current phase matches.
{
  const config = {
    roles: {
      implementer: {
        adapter: "anthropic",
        model: "claude-haiku",
        escalation_model: {
          adapter: "anthropic",
          model: "claude-sonnet",
        },
      },
    },
  };

  const entry = {
    role: "implementer",
    from: { adapter: "anthropic", model: "claude-haiku" },
    to: { adapter: "anthropic", model: "claude-sonnet" },
    budget: "implementationFailureBudget",
    used: 3,
    limit: 5,
    at: new Date().toISOString(),
  };

  // Case A: currently in phaseIndex 1, but budgetEscalations only has phase 0
  const statePhase1 = {
    phaseIndex: 1,
    budgetEscalations: {
      "standalone:phase-0": entry,
    },
  };
  assert.equal(
    budgetEscalationModel(statePhase1, config),
    null,
    "budgetEscalationModel returns null when only another phase has an entry"
  );
  assert.equal(
    implementerModelFor(statePhase1, config).model,
    "claude-haiku",
    "implementerModelFor returns normal model when current phase has no escalation entry"
  );

  // Case B: phaseIndex past the plan / final-review fix round (e.g. phaseIndex 99)
  const stateFinalReview = {
    phaseIndex: 99,
    budgetEscalations: {
      "standalone:phase-0": entry,
    },
  };
  assert.equal(
    budgetEscalationModel(stateFinalReview, config),
    null,
    "budgetEscalationModel returns null when phaseIndex is past the plan"
  );
  assert.equal(
    implementerModelFor(stateFinalReview, config).model,
    "claude-haiku",
    "implementerModelFor returns normal model when phaseIndex is past the plan"
  );

  // Case C: no phaseIndex or currentPhase in state
  const stateNoPhase = {
    budgetEscalations: {
      "standalone:phase-0": entry,
    },
  };
  assert.equal(
    budgetEscalationModel(stateNoPhase, config),
    null,
    "budgetEscalationModel returns null when state has no matching phase"
  );
  assert.equal(
    implementerModelFor(stateNoPhase, config).model,
    "claude-haiku",
    "implementerModelFor returns normal model when state has no matching phase"
  );
}
console.log("PASS 2. state-level test: survives consumeEscalationFor and model selection returns escalation model");

// 3. Without escalation_model nothing changes
{
  const configNoEsc = {
    roles: {
      implementer: {
        adapter: "anthropic",
        model: "claude-haiku",
      },
    },
  };
  const decision = budgetEscalationDecision({ used: 3, limit: 5, hasEscalationModel: false, alreadySwitched: false });
  assert.equal(decision, "none");
  const model = implementerModelFor({}, configNoEsc, "standalone:phase-0");
  assert.equal(model.model, "claude-haiku");
}
console.log("PASS 3. without escalation_model nothing changes");

// 4. Source checks for autopilot.mjs wiring
{
  const autoSrc = fs.readFileSync(path.join(__dirname, "autopilot.mjs"), "utf8");

  // MISSION_SCOPED_STATE_KEYS includes budgetEscalations
  assert.match(
    autoSrc,
    /MISSION_SCOPED_STATE_KEYS\s*=\s*Object\.freeze\(\[\s*[\s\S]*?"budgetEscalations"[\s\S]*?\]\)/,
    "MISSION_SCOPED_STATE_KEYS includes budgetEscalations"
  );

  // Standalone loop calls helper after recording failure budget
  assert.match(
    autoSrc,
    /enforceAttemptFailure\(c,s,`standalone:phase-\$\{s\.phaseIndex\}`,[\s\S]*?\);\s*noteBudgetEscalationTrigger\(s,c,`standalone:phase-\$\{s\.phaseIndex\}`,recorded\.budget\);/,
    "standalone loop calls noteBudgetEscalationTrigger after recording phase failure budget"
  );

  // SpecKit loop calls helper after recording failure budget
  assert.match(
    autoSrc,
    /enforceAttemptFailure\(c,s,`speckit:\$\{phase\.name\}`,[\s\S]*?\);\s*noteBudgetEscalationTrigger\(s,c,`speckit:\$\{phase\.name\}`,recorded\.budget\);/,
    "speckit loop calls noteBudgetEscalationTrigger after recording phase failure budget"
  );

  // Clear entry on phase pass in standalone loop
  assert.match(
    autoSrc,
    /clearBudgetEscalation\(s,`standalone:phase-\$\{s\.phaseIndex\}`\)/,
    "standalone loop clears budgetEscalations on phase pass"
  );

  // Clear entry on phase pass in speckit loop
  assert.match(
    autoSrc,
    /clearBudgetEscalation\(s,`speckit:\$\{phase\.name\}`\)/,
    "speckit loop clears budgetEscalations on phase pass"
  );

  // ap reset clears budgetEscalations in global reset
  assert.match(
    autoSrc,
    /for\(const k of Object\.keys\(s\.budgetEscalations\|\|\{\}\)\)\{\s*cleared\.push\(`budgetEscalations:\$\{k\}`\);\s*delete s\.budgetEscalations\[k\];\s*\}/,
    "ap reset clears budgetEscalations in clearAllSpentCounters (global reset)"
  );

  // ap reset clears budgetEscalations in live scoped reset
  assert.match(
    autoSrc,
    /delete s\.failureBudgets\[key\];\s*clearBudgetEscalation\(s,\s*scope\);/,
    "applyPendingBudgetReset clears budgetEscalations for scope"
  );

  // ap reset clears budgetEscalations in offline scoped reset
  assert.match(
    autoSrc,
    /delete budgets\[key\];\s*clearBudgetEscalation\(s,\s*scope\);/,
    "resetFailureCommand clears budgetEscalations for scope"
  );

  // Model selection honours budgetEscalations
  assert.match(
    autoSrc,
    /budgetEscalationModel\(s,c\)/,
    "model selection honours budgetEscalationModel"
  );
}
console.log("PASS 4. source checks in autopilot.mjs");

// 5. Default 5 checks for config-migration and setup
{
  const migSrc = fs.readFileSync(path.join(__dirname, "config-migration.mjs"), "utf8");
  assert.match(
    migSrc,
    /implementationFailureBudget:\s*5/,
    "config-migration.mjs has default implementationFailureBudget: 5"
  );
  assert.match(
    migSrc,
    /verificationFailureBudget:\s*5/,
    "config-migration.mjs has default verificationFailureBudget: 5"
  );

  const setupSrc = fs.readFileSync(path.join(__dirname, "setup.mjs"), "utf8");
  assert.match(
    setupSrc,
    /implementationFailureBudget:\s*5/,
    "setup.mjs has default implementationFailureBudget: 5"
  );
  assert.match(
    setupSrc,
    /verificationFailureBudget:\s*5/,
    "setup.mjs has default verificationFailureBudget: 5"
  );

  const watchSrc = fs.readFileSync(path.join(__dirname, "watch-report.mjs"), "utf8");
  assert.match(
    watchSrc,
    /implementationFailureBudget:\s*5/,
    "watch-report.mjs has default implementationFailureBudget: 5"
  );
  assert.match(
    watchSrc,
    /verificationFailureBudget:\s*5/,
    "watch-report.mjs has default verificationFailureBudget: 5"
  );

  const implDefault = recordFailureBudget({}, {}, failure("IMPLEMENTATION_REJECTED", "implementation", true), "task:test").limit;
  assert.equal(
    implDefault,
    5,
    "failure-contract default implementationFailureBudget is 5"
  );
  const verifDefault = recordFailureBudget({}, {}, failure("VERIFICATION_REJECTED", "verification", true), "task:test").limit;
  assert.equal(
    verifDefault,
    5,
    "failure-contract default verificationFailureBudget is 5"
  );

  assert.equal(
    DEFAULTS.retries.implementation,
    5,
    "config-layout DEFAULTS.retries.implementation is 5"
  );
  assert.equal(
    DEFAULTS.retries.verification,
    5,
    "config-layout DEFAULTS.retries.verification is 5"
  );
}
console.log("PASS 5. default 5 checks for config-migration, setup, watch-report, failure-contract, and config-layout");

console.log("\nAll budget escalation tests passed.");
