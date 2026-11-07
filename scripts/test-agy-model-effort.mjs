#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { agyModelEffortConflict, normalizeAgyModelEffort, extractCatalogModelIds } from "./agy-model-effort.mjs";
import { decodeAgyEvents, observeAgyEvents } from "./agy-events.mjs";
import { classifyObservedFailure, recordFailureBudget } from "./failure-contract.mjs";
import { normalizeAgyRole } from "./setup.mjs";
import { preflightAdapter } from "./preflight.mjs";

let checks = 0;
function check(label, condition, detail = "") {
  checks++;
  assert.ok(condition, `${label}${detail ? ` - ${detail}` : ""}`);
  console.log(`  ok - ${label}`);
}

console.log("1. Helper agyModelEffortConflict & normalizeAgyModelEffort cases");
{
  // 1a. Different tier -> conflict
  const c1 = agyModelEffortConflict("gemini-3.8-flash-high", "medium");
  check("different tier: high + medium conflicts", c1 !== null);
  check("different tier: model preserved", c1?.model === "gemini-3.8-flash-high");
  check("different tier: effort preserved", c1?.effort === "medium");
  check("different tier: suggested normalized to effort tier", c1?.suggested === "gemini-3.8-flash-medium");

  const c2 = agyModelEffortConflict("gemini-3.8-flash-low", "high");
  check("different tier: low + high conflicts", c2 !== null && c2.suggested === "gemini-3.8-flash-high");

  // 1b. Same tier -> compatible (null)
  check("same tier: high + high is null", agyModelEffortConflict("gemini-3.8-flash-high", "high") === null);
  check("same tier: medium + medium is null", agyModelEffortConflict("gemini-3.8-flash-medium", "medium") === null);
  check("same tier: low + low is null", agyModelEffortConflict("gemini-3.8-flash-low", "low") === null);

  // 1c. No tier suffix in model id -> compatible (null)
  check("no tier: base model is null", agyModelEffortConflict("gemini-3.8-flash", "medium") === null);
  check("no tier: custom model without tier is null", agyModelEffortConflict("claude-sonnet-4-6", "high") === null);

  // 1d. No effort (null / empty / undefined) -> compatible (null)
  check("no effort: null effort is null", agyModelEffortConflict("gemini-3.8-flash-high", null) === null);
  check("no effort: empty string effort is null", agyModelEffortConflict("gemini-3.8-flash-high", "") === null);
  check("no effort: whitespace effort is null", agyModelEffortConflict("gemini-3.8-flash-high", "   ") === null);
  check("no effort: undefined effort is null", agyModelEffortConflict("gemini-3.8-flash-high", undefined) === null);
  check("no model: null model is null", agyModelEffortConflict(null, "medium") === null);

  // 1e. Catalog matching in normalizeAgyModelEffort
  const liveCatalog = [
    {
      id: "gemini-3.8-flash",
      effortModelIds: {
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high"
      }
    }
  ];

  // Suggested in catalog -> suggested chosen
  const normSuggested = normalizeAgyModelEffort("gemini-3.8-flash-high", "medium", liveCatalog);
  check("catalog: suggested chosen when present", normSuggested.changed && normSuggested.model === "gemini-3.8-flash-medium");

  // Suggested not in catalog, but base is in catalog -> base chosen
  const baseOnlyCatalog = [{ id: "gemini-3.8-flash", effortModelIds: { high: "gemini-3.8-flash-high" } }];
  const normBase = normalizeAgyModelEffort("gemini-3.8-flash-high", "medium", baseOnlyCatalog);
  check("catalog: base model chosen when suggested absent but base present", normBase.changed && normBase.model === "gemini-3.8-flash");

  // Neither suggested nor base is in catalog -> left untouched
  const unrelatedCatalog = [{ id: "gemini-1.5-pro", effortModelIds: { high: "gemini-1.5-pro-high" } }];
  const normNeither = normalizeAgyModelEffort("gemini-3.8-flash-high", "medium", unrelatedCatalog);
  check("catalog: model untouched when neither suggested nor base present", !normNeither.changed && normNeither.model === "gemini-3.8-flash-high");
}

console.log("2. Setup normalization (calling real normalizeAgyRole)");
{
  const catalog = [
    {
      id: "gemini-3.8-flash",
      effortModelIds: {
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high"
      }
    }
  ];

  // 2a. Conflicting role normalized to suggested model
  const role1 = { adapter: "antigravity", model: "gemini-3.8-flash-high", reasoning: "medium" };
  const res1 = normalizeAgyRole(role1, catalog);
  check("setup: conflicting antigravity role normalized", res1.changed === true);
  check("setup: normalized model matches suggested", res1.role.model === "gemini-3.8-flash-medium");
  check("setup: reasoning untouched", res1.role.reasoning === "medium");

  // 2b. Compatible role left unchanged
  const role2 = { adapter: "antigravity", model: "gemini-3.8-flash-medium", reasoning: "medium" };
  const res2 = normalizeAgyRole(role2, catalog);
  check("setup: compatible role untouched", res2.changed === false && res2.role.model === "gemini-3.8-flash-medium");

  // 2c. Non-antigravity role untouched
  const role3 = { adapter: "claude", model: "claude-sonnet-4-6", reasoning: "medium" };
  const res3 = normalizeAgyRole(role3, catalog);
  check("setup: non-antigravity role untouched", res3.changed === false && res3.role.model === "claude-sonnet-4-6");

  // 2d. Suggested absent, base present in catalog -> normalized to base
  const role4 = { adapter: "antigravity", model: "gemini-3.8-flash-high", reasoning: "medium" };
  const res4 = normalizeAgyRole(role4, [{ id: "gemini-3.8-flash" }]);
  check("setup: normalized to base model when suggested absent", res4.changed === true && res4.role.model === "gemini-3.8-flash");

  // 2e. Neither suggested nor base in catalog -> left untouched
  const role5 = { adapter: "antigravity", model: "gemini-3.8-flash-high", reasoning: "medium" };
  const res5 = normalizeAgyRole(role5, [{ id: "other-model" }]);
  check("setup: unlisted model left untouched", res5.changed === false && res5.role.model === "gemini-3.8-flash-high");
}

console.log("3. Preflight normalization (calling real preflightAdapter)");
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-agy-test-"));
  try {
    const fakeAdapter = {
      binary: "agy",
      model_flag: "--model",
      effort_flag: "--effort",
      write: ["run"],
      read_only: ["plan"]
    };

    // Shared mock probe cache so executable Availability doesn't spawn real CLI
    const probeCache = new Map();
    probeCache.set(`exe antigravity agy --version`, []);
    probeCache.set(`paths ${tmpRepo}`, []);

    // 3a. Preflight normalizes conflicting model/effort pair for antigravity role
    const role1 = { model: "gemini-3.8-flash-high", reasoning: "medium" };
    const res1 = preflightAdapter({
      repo: tmpRepo,
      adapterId: "antigravity",
      adapter: fakeAdapter,
      role: role1,
      probeCache
    });
    check("preflight: succeeds after normalizing compatible pair", res1.ok === true);
    check("preflight: delivered role model normalized to suggested", role1.model === "gemini-3.8-flash-medium");

    // 3b. Preflight with catalog when neither suggested nor base is in catalog fails closed
    const role2 = { model: "gemini-3.8-flash-high", reasoning: "medium" };
    const catalog = [{ id: "unrelated-model" }];
    const res2 = preflightAdapter({
      repo: tmpRepo,
      adapterId: "antigravity",
      adapter: fakeAdapter,
      role: role2,
      probeCache,
      catalog
    });
    check("preflight: fails when conflicting model cannot be resolved in catalog", res2.ok === false);
    check("preflight: problems describe unresolvable conflict", res2.problems.some(p => p.includes("conflicts with effort")));

    // 3c. Preflight with catalog when suggested is present succeeds and normalizes
    const role3 = { model: "gemini-3.8-flash-high", reasoning: "medium" };
    const goodCatalog = [{ id: "gemini-3.8-flash", effortModelIds: { medium: "gemini-3.8-flash-medium" } }];
    const res3 = preflightAdapter({
      repo: tmpRepo,
      adapterId: "antigravity",
      adapter: fakeAdapter,
      role: role3,
      probeCache,
      catalog: goodCatalog
    });
    check("preflight: succeeds when suggested is in catalog", res3.ok === true);
    check("preflight: normalized model is suggested", role3.model === "gemini-3.8-flash-medium");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

console.log("4. Exact rejection text classifies INVOCATION_MISMATCH non-retryable");
{
  const exactRejectionText = "invalid model selection: gemini-3.8-flash-high conflicts with --effort=medium";

  // 4a. Decoded events and observation detection
  const events = decodeAgyEvents("", exactRejectionText);
  check("decodeAgyEvents captured stderr event", events.length === 1 && events[0].type === "stderr");
  const observations = observeAgyEvents(events);
  check("observeAgyEvents emitted invalid_model observation", observations.some(o => o.type === "invalid_model"));
  const invalidObs = observations.find(o => o.type === "invalid_model");
  check("invalid_model observation records reason", invalidObs?.reason === "agy_invalid_model_selection");

  // 4b. Classification with structured observation
  const classifiedFromEvidence = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: exactRejectionText,
    evidence: observations,
    adapter: "antigravity"
  });
  check("classification from evidence: failure class is INVOCATION_MISMATCH", classifiedFromEvidence?.class === "INVOCATION_MISMATCH");
  check("classification from evidence: failure domain is adapter", classifiedFromEvidence?.domain === "adapter");
  check("classification from evidence: retryable is false", classifiedFromEvidence?.retryable === false);

  // 4c. Classification from stderr text fallback directly
  const classifiedFromStderr = classifyObservedFailure({
    exitCode: 1,
    stdout: "",
    stderr: `Some prefix\n${exactRejectionText}\nsome suffix`,
    evidence: [],
    adapter: "antigravity"
  });
  check("classification from stderr: failure class is INVOCATION_MISMATCH", classifiedFromStderr?.class === "INVOCATION_MISMATCH");
  check("classification from stderr: failure domain is adapter", classifiedFromStderr?.domain === "adapter");
  check("classification from stderr: retryable is false", classifiedFromStderr?.retryable === false);

  // 4d. recordFailureBudget consumes zero retries and disallows retry
  const budgetState = {};
  const policy = { failure_budgets: { adapterRetryBudget: 3 } };
  const budgetDecision = recordFailureBudget(budgetState, policy, classifiedFromEvidence, "adapter:antigravity:implementer");
  check("recordFailureBudget: allowed is false", budgetDecision.allowed === false);
  check("recordFailureBudget: used is 0 (zero retries consumed)", budgetDecision.used === 0);
  check("recordFailureBudget: state counter is not incremented", Object.keys(budgetState.failureBudgets || {}).length === 0);
}

console.log("5. Source checks: autopilot.mjs does not reference contractCache");
{
  const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("autopilot.mjs does not contain contractCache", !autopilotSource.includes("contractCache"));
}

console.log(`\ntest-agy-model-effort: ALL ${checks} CHECKS PASSED`);
