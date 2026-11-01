#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveMaxPhaseTasks,
  resolveMinPhaseTasks,
  MAX_PHASE_TASKS_DEFAULT,
  MIN_PHASE_TASKS_DEFAULT,
} from "./per-task-budget.mjs";
import { toRuntimeConfig, DEFAULTS } from "./config-layout.mjs";
import { migrateConfig } from "./config-migration.mjs";
import { validateNewConfig, validatePolicyConfig } from "./config-validation.mjs";
import { phaseTaskCountFindings } from "./verify-denylist.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── a. resolveMaxPhaseTasks / resolveMinPhaseTasks ──────────────────────────
check("resolveMaxPhaseTasks defaults with empty policy", resolveMaxPhaseTasks({}) === 10);
check("resolveMinPhaseTasks defaults with empty policy", resolveMinPhaseTasks({}) === 3);
check("resolveMaxPhaseTasks defaults with undefined", resolveMaxPhaseTasks(undefined) === 10);
check("resolveMinPhaseTasks defaults with undefined", resolveMinPhaseTasks(undefined) === 3);

check("resolveMaxPhaseTasks custom value 15", resolveMaxPhaseTasks({ max_phase_tasks: 15 }) === 15);
check("resolveMinPhaseTasks custom value 2", resolveMinPhaseTasks({ min_phase_tasks: 2 }) === 2);
check(
  "resolveMaxPhaseTasks and resolveMinPhaseTasks combined",
  resolveMaxPhaseTasks({ max_phase_tasks: 15, min_phase_tasks: 2 }) === 15 &&
  resolveMinPhaseTasks({ max_phase_tasks: 15, min_phase_tasks: 2 }) === 2
);

for (const bad of [0, -1, 2.5, "x", null, NaN]) {
  check(
    `resolveMaxPhaseTasks invalid value ${JSON.stringify(bad)} falls back to default`,
    resolveMaxPhaseTasks({ max_phase_tasks: bad }) === MAX_PHASE_TASKS_DEFAULT,
    resolveMaxPhaseTasks({ max_phase_tasks: bad })
  );
  check(
    `resolveMinPhaseTasks invalid value ${JSON.stringify(bad)} falls back to default`,
    resolveMinPhaseTasks({ min_phase_tasks: bad }) === MIN_PHASE_TASKS_DEFAULT,
    resolveMinPhaseTasks({ min_phase_tasks: bad })
  );
}

// ── b. config layout ────────────────────────────────────────────────────────
const customLayout = {
  caps: {
    max_phase_tasks: 15,
    min_phase_tasks: 2,
  },
};
const customRt = toRuntimeConfig(customLayout);
check(
  "config layout maps caps.max_phase_tasks to policy.max_phase_tasks",
  customRt.policy.max_phase_tasks === 15,
  customRt.policy.max_phase_tasks
);
check(
  "config layout maps caps.min_phase_tasks to policy.min_phase_tasks",
  customRt.policy.min_phase_tasks === 2,
  customRt.policy.min_phase_tasks
);

const migratedAbsent = migrateConfig({}).config;
const absentRt = toRuntimeConfig(migratedAbsent);
check(
  "config layout defaults appear when keys are absent (max_phase_tasks: 10)",
  absentRt.policy.max_phase_tasks === 10,
  absentRt.policy.max_phase_tasks
);
check(
  "config layout defaults appear when keys are absent (min_phase_tasks: 3)",
  absentRt.policy.min_phase_tasks === 3,
  absentRt.policy.min_phase_tasks
);

const defaultsRt = toRuntimeConfig(DEFAULTS);
check(
  "DEFAULTS layout maps max_phase_tasks to 10 in runtime policy",
  defaultsRt.policy.max_phase_tasks === 10
);
check(
  "DEFAULTS layout maps min_phase_tasks to 3 in runtime policy",
  defaultsRt.policy.min_phase_tasks === 3
);

// ── c. validation ───────────────────────────────────────────────────────────
const badMaxValidation = validateNewConfig({ caps: { max_phase_tasks: 0 } });
check(
  "validation rejects caps.max_phase_tasks 0",
  badMaxValidation.errors.some((e) => e.includes("caps.max_phase_tasks")),
  badMaxValidation.errors
);

const badMinValidation = validateNewConfig({ caps: { min_phase_tasks: "x" } });
check(
  "validation rejects caps.min_phase_tasks 'x'",
  badMinValidation.errors.some((e) => e.includes("caps.min_phase_tasks")),
  badMinValidation.errors
);

const goodValidation = validateNewConfig({ caps: { max_phase_tasks: 15, min_phase_tasks: 2 } });
check(
  "validation accepts caps.max_phase_tasks 15 and caps.min_phase_tasks 2",
  !goodValidation.errors.some((e) => e.includes("phase_tasks")),
  goodValidation.errors
);

const badPolicyMax = validatePolicyConfig({ max_phase_tasks: 0 });
check(
  "policy validation rejects policy.max_phase_tasks 0",
  badPolicyMax.errors.some((e) => e.includes("policy.max_phase_tasks")),
  badPolicyMax.errors
);

const badPolicyMin = validatePolicyConfig({ min_phase_tasks: "x" });
check(
  "policy validation rejects policy.min_phase_tasks 'x'",
  badPolicyMin.errors.some((e) => e.includes("policy.min_phase_tasks")),
  badPolicyMin.errors
);

const goodPolicy = validatePolicyConfig({ max_phase_tasks: 15, min_phase_tasks: 2 });
check(
  "policy validation accepts valid max_phase_tasks 15 and min_phase_tasks 2",
  !goodPolicy.errors.some((e) => e.includes("phase_tasks")),
  goodPolicy.errors
);

// ── d. config.schema.json ───────────────────────────────────────────────────
const schemaPath = path.join(HERE, "..", "config.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const capsProps = schema.properties?.caps?.properties;
check(
  "config.schema.json defines caps.max_phase_tasks with minimum 1 and default 10",
  capsProps?.max_phase_tasks?.type === "number" &&
  capsProps?.max_phase_tasks?.minimum === 1 &&
  capsProps?.max_phase_tasks?.default === 10,
  capsProps?.max_phase_tasks
);
check(
  "config.schema.json defines caps.min_phase_tasks with minimum 1 and default 3",
  capsProps?.min_phase_tasks?.type === "number" &&
  capsProps?.min_phase_tasks?.minimum === 1 &&
  capsProps?.min_phase_tasks?.default === 3,
  capsProps?.min_phase_tasks
);
check(
  "config.schema.json caps default object contains max_phase_tasks: 10 and min_phase_tasks: 3",
  schema.properties?.caps?.default?.max_phase_tasks === 10 &&
  schema.properties?.caps?.default?.min_phase_tasks === 3,
  schema.properties?.caps?.default
);

// ── e. phaseTaskCountFindings ───────────────────────────────────────────────
const tasks11 = [
  "## Phase 1: Feature Implementation",
  ...Array.from({ length: 11 }, (_, i) => `- [ ] **1.${i + 1}** task ${i + 1}; verify: test.mjs`),
].join("\n");

const findings15 = phaseTaskCountFindings(tasks11, 15);
check(
  "phaseTaskCountFindings with 11 tasks and max 15 produces no findings",
  findings15.length === 0,
  findings15
);

const findings10 = phaseTaskCountFindings(tasks11, 10);
check(
  "phaseTaskCountFindings with 11 tasks and max 10 produces 1 finding",
  findings10.length === 1 &&
  findings10[0].location === "TASKS.md Phase 1" &&
  findings10[0].problem.includes("11 tasks (maximum 10 per phase)"),
  findings10
);

// ── f. source check in scripts/autopilot.mjs ─────────────────────────────────
const autopilotPath = path.join(HERE, "autopilot.mjs");
const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

const plannerLineOk = autopilotSrc.includes("const phaseTaskLimitLine=`Keep each phase to at most ${resolveMaxPhaseTasks(c.policy)} tasks");
check(
  "source check: planner line uses resolveMaxPhaseTasks(c.policy)",
  plannerLineOk
);

const reviewerLineOk = autopilotSrc.includes("`FAIL any phase with more than ${resolveMaxPhaseTasks(c.policy)} tasks, citing the phase");
check(
  "source check: reviewer line uses resolveMaxPhaseTasks(c.policy)",
  reviewerLineOk
);

const deterministicCheckOk = autopilotSrc.includes("phaseTaskCountFindings(standaloneTasksText, resolveMaxPhaseTasks(c.policy))");
check(
  "source check: deterministic check passes resolveMaxPhaseTasks(c.policy) to phaseTaskCountFindings",
  deterministicCheckOk
);

const speckitGateOk = autopilotSrc.includes("FAIL any phase with more than ${resolveMaxPhaseTasks(c.policy)} tasks, citing the phase; it must be split into additional phases.");
check(
  "source check: SpecKit gate note uses resolveMaxPhaseTasks(c.policy)",
  speckitGateOk
);

const occurrences = (autopilotSrc.match(/resolveMaxPhaseTasks\(c\.policy\)/g) || []).length;
check(
  "source check: scripts/autopilot.mjs contains resolveMaxPhaseTasks(c.policy) in at least 4 places",
  occurrences >= 4,
  occurrences
);

const sentence1 = "A phase with fewer than ${resolveMinPhaseTasks(c.policy)} tasks should be merged into a neighbouring related phase when the merged phase stays within ${resolveMaxPhaseTasks(c.policy)} tasks and the task order stays correct.";
check(
  "source check: planner sentence 1 present in autopilot.mjs",
  autopilotSrc.includes(sentence1)
);

const sentence2 = "A phase with fewer than ${resolveMinPhaseTasks(c.policy)} tasks that could join a neighbouring related phase (staying within ${resolveMaxPhaseTasks(c.policy)} tasks, order unchanged) goes in \"notes\", never in \"findings\".";
check(
  "source check: reviewer notes sentence 2 present in autopilot.mjs",
  autopilotSrc.includes(sentence2)
);

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All phase-size config checks passed.");
