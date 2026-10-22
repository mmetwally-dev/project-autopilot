// Backlog #111: sizing target (policy.task_size_target_turns) separate from caps.
import {taskSizingRuleText, taskSizeReviewText, resolveTaskSizeTargetTurns, PER_TASK_MAX_TURNS_DEFAULT, PER_ROLE_CAPS_DEFAULT, FREE_MODEL_TURNS_CAP_DEFAULT} from "./per-task-budget.mjs";
import {migrateConfig, loadAndMigrateConfig} from "./config-migration.mjs";
import {toRuntimeConfig} from "./config-layout.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let fails = 0;
const check = (n, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fails++; };

check("target defaults to 30", resolveTaskSizeTargetTurns({}) === 30 && resolveTaskSizeTargetTurns(undefined) === 30);
check("target override honoured; invalid falls back", resolveTaskSizeTargetTurns({task_size_target_turns: 20}) === 20 && resolveTaskSizeTargetTurns({task_size_target_turns: -1}) === 30 && resolveTaskSizeTargetTurns({task_size_target_turns: 1.5}) === 30);
check("planner text uses target (default and override)", taskSizingRuleText(30).includes("about 30 implementer turns") && taskSizingRuleText(20).includes("about 20 implementer turns") && taskSizingRuleText(30).includes("one implementer session"));
check("planner text carries the cannot-split annotation", taskSizingRuleText(30).includes("size: cannot split — <reason>"));
check("planner text carries the concrete one-action size rule", taskSizingRuleText(30).includes("ONE concrete action") && taskSizingRuleText(30).includes("about ONE file") && taskSizingRuleText(30).includes("name the exact file path"));
check("planner text carries the top rule task size wins over phase count", taskSizingRuleText(30).includes("Task size wins over phase count"));
const rv = taskSizeReviewText(25);
check("reviewer text: target, annotation accepted, concrete split required", rv.includes("About 25 implementer turns") && rv.includes("size: cannot split") && rv.includes("accept it") && rv.includes("concrete split"));
check("reviewer text FAILs the concrete count rule, not a turn guess", rv.includes("more than 3 distinct changes") && rv.includes("more than 2 files to edit") && rv.includes("never FAIL a task on a turn estimate alone"));
check("defaults: implementer 40, plan_reviewer 30, free 45, code_reviewer 22", PER_TASK_MAX_TURNS_DEFAULT === 40 && PER_ROLE_CAPS_DEFAULT.plan_reviewer.maxTurns === 30 && FREE_MODEL_TURNS_CAP_DEFAULT === 45 && PER_ROLE_CAPS_DEFAULT.code_reviewer.maxTurns === 22);

const base = {schema_version: "1.4", project: {planning_framework: "gsd"}, roles: {}};
// migrateConfig yields the v4 layout; wrap through toRuntimeConfig to read the
// runtime policy the code consumes.
const toRt = (input) => toRuntimeConfig(migrateConfig(input).config);
const old = toRt({...base, policy: {per_task_max_turns: 30, caps: {plan_reviewer: {max_turns: 22}, code_reviewer: {max_turns: 22}}}});
check("migration: old defaults 30/22 upgraded to 40/30", old.policy.per_task_max_turns === 40 && old.policy.caps.plan_reviewer.max_turns === 30 && old.policy.caps.code_reviewer.max_turns === 22);
const custom = toRt({...base, policy: {per_task_max_turns: 35, caps: {plan_reviewer: {max_turns: 25}}}});
check("migration: custom values kept", custom.policy.per_task_max_turns === 35 && custom.policy.caps.plan_reviewer.max_turns === 25);
const layoutOld = migrateConfig({...base, policy: {per_task_max_turns: 30, caps: {plan_reviewer: {max_turns: 22}, code_reviewer: {max_turns: 22}}}});
const again = toRt(layoutOld.config);
check("migration: idempotent", again.policy.per_task_max_turns === 40 && again.policy.caps.plan_reviewer.max_turns === 30);
// Test the one-time marker (defaults_111_applied) persistence through the
// full load path with meta file. Scenario: v3 config with legacy default 30
// migrates to v4 (rewritten to 40, marker set in meta). Operator then
// deliberately sets per_task_max_turns back to 30 in the v4 config. Next load
// should preserve the deliberate 30 because marker is already set.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-111-marker-"));
const configPath = path.join(tempDir, "config.json");
const metaPath = path.join(tempDir, "config.meta.json");
try {
  // Initial v3 config with legacy default per_task_max_turns: 30.
  const v3Input = {...base, policy: {per_task_max_turns: 30, caps: {plan_reviewer: {max_turns: 22}}}};
  fs.writeFileSync(configPath, JSON.stringify(v3Input, null, 2));
  
  // First load: migrate v3 -> v4, rewrites 30->40, writes meta with defaults_111_applied=true.
  const firstLoad = loadAndMigrateConfig(configPath, {persist: true});
  check("migration: marker set after first pass", firstLoad.meta?.config_metadata?.defaults_111_applied === true);
  check("migration: legacy 30 rewritten to 40 on first pass", firstLoad.config.policy.per_task_max_turns === 40);
  
  // Read the meta file to verify it was written.
  const metaAfterFirst = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  check("meta file: defaults_111_applied written", metaAfterFirst.config_metadata?.defaults_111_applied === true);
  
  // Operator deliberately sets per_task_max_turns back to 30 in the v4 config.
  // This simulates the operator editing the persisted v4 config.json directly.
  const operatorEditedV4 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  operatorEditedV4.caps.implementer.max_turns = 30;
  operatorEditedV4.caps.plan_reviewer.max_turns = 22;
  fs.writeFileSync(configPath, JSON.stringify(operatorEditedV4, null, 2));
  
  // Second load: v4 config with operator's deliberate 30, meta has marker=true.
  // Should preserve the 30 because marker is already set.
  const secondLoad = loadAndMigrateConfig(configPath, {persist: false});
  check("migration: one-time marker keeps a deliberate 30 / plan_reviewer 22 (with meta)", secondLoad.config.policy.per_task_max_turns === 30 && secondLoad.config.policy.caps.plan_reviewer.max_turns === 22);
  
  // Third load (idempotence): marker still there, no rewrite.
  const thirdLoad = loadAndMigrateConfig(configPath, {persist: false});
  check("migration: third pass does not rewrite a re-set 30", thirdLoad.config.policy.per_task_max_turns === 30 && !thirdLoad.changed);
} finally {
  fs.rmSync(tempDir, {recursive: true, force: true});
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("autopilot.mjs wires target into planner, speckit contract and both reviewers",
  src.includes("const oneSessionLine=taskSizingRuleText(resolveTaskSizeTargetTurns(c.policy))")
  && src.includes("${taskSizingRuleText(sizeTarget)}")
  && (src.match(/taskSizeReviewText\(resolveTaskSizeTargetTurns\(c\.policy\)\)/g) || []).length >= 2);
const {validatePolicyConfig} = await import("./config-validation.mjs");
const badV = JSON.stringify(validatePolicyConfig({task_size_target_turns: 0}));
const okV = JSON.stringify(validatePolicyConfig({task_size_target_turns: 20}));
check("validation: target must be a positive integer", badV.includes("task_size_target_turns") && !okV.includes("task_size_target_turns"));
process.exit(fails ? 1 : 0);
