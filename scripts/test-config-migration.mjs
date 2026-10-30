#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadAndMigrateConfig, CURRENT_SCHEMA, migrateConfig} from './config-migration.mjs';
import {toRuntimeConfig} from './config-layout.mjs';
import {validatePolicyConfig} from './config-validation.mjs';
import {resolveFinalReviewFixRounds, FINAL_REVIEW_FIX_ROUNDS_DEFAULT} from './per-task-budget.mjs';
import {fileURLToPath} from 'node:url';

// Backlog #1 (mission 096 Phase 1 task 1.3): migrateConfig yields the v4 on-disk
// layout. Code that reads the runtime shape goes through toRuntimeConfig, so the
// assertions below use these two helpers: layoutOf() for the file, runtimeOf()
// for the shape the runtime consumes.
const layoutOf = input => migrateConfig(input).config;
const runtimeOf = input => toRuntimeConfig(migrateConfig(input).config);
const V4_SECTIONS = ['project', 'roles', 'caps', 'retries', 'time_limits', 'workflow', 'tests', 'safety', 'runtime', 'frameworks', 'advanced'];

const old={
  schema_version:'1.4',
  project:{planning_framework:'gsd'},
  roles:{planner:{adapter:'claude',model:'opus',reasoning:'high',variant:'',resume:true}},
};
const direct=migrateConfig(old);
if(direct.to!==CURRENT_SCHEMA || direct.from!=='1.4') throw new Error('Direct migration from/to wrong');
// v4 layout: $schema first, schema_version "4.0", operator role values kept under the new names.
const directLayout = direct.config;
if (Object.keys(directLayout)[0] !== '$schema') throw new Error(`$schema must be the first key: ${JSON.stringify(Object.keys(directLayout))}`);
if (directLayout.schema_version !== '4.0') throw new Error(`schema_version !== 4.0: ${directLayout.schema_version}`);
for (const section of V4_SECTIONS) if (!(section in directLayout)) throw new Error(`Missing v4 section ${section}`);
if (directLayout.roles.planner.cli !== 'claude' || directLayout.roles.planner.model !== 'opus' || directLayout.roles.planner.reasoning !== 'high') throw new Error(`Operator role values lost: ${JSON.stringify(directLayout.roles.planner)}`);
// Machine-written fields never stay in the user's file; they move to `meta`.
if ('model_source' in directLayout.roles.planner || 'config_metadata' in directLayout) throw new Error('Machine fields leaked into the v4 layout');
if (direct.meta?.roles?.planner?.model_source !== 'unknown') throw new Error(`meta role model_source missing: ${JSON.stringify(direct.meta)}`);
if (direct.meta?.config_metadata?.migrated_from !== '1.4') throw new Error(`meta config_metadata.migrated_from wrong: ${JSON.stringify(direct.meta?.config_metadata)}`);
// The runtime shape still resolves the operator role.
if (toRuntimeConfig(directLayout).roles.planner.adapter !== 'claude') throw new Error('toRuntimeConfig did not resolve the migrated role');

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ap-migration-'));
tempDirs.add(tmp);
const file=path.join(tmp,'config.json'); fs.writeFileSync(file,JSON.stringify(old,null,2));
const loaded=loadAndMigrateConfig(file,{persist:true});
if(!loaded.changed || !loaded.backupPath || !fs.existsSync(loaded.backupPath)) throw new Error('Persistent migration failed');
const reread=JSON.parse(fs.readFileSync(file,'utf8'));
if(reread.schema_version!==CURRENT_SCHEMA) throw new Error(`Wrong schema: ${reread.schema_version}`);
if(Object.keys(reread)[0]!=='$schema') throw new Error('persisted $schema is not first');
// Machine-written fields moved to .autopilot/config.meta.json (same dir as config.json).
const metaPath=path.join(tmp,'config.meta.json');
if(!fs.existsSync(metaPath)) throw new Error('config.meta.json was not written');
const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
if(meta?.roles?.planner?.model_source!=='unknown' || !meta?.config_metadata) throw new Error(`config.meta.json content wrong: ${JSON.stringify(meta)}`);
if('config_metadata' in reread || 'model_source' in reread.roles.planner) throw new Error('machine fields still in persisted config.json');

// Per-task caps live under caps.implementer with values taken from the code
// constants (per-task-budget.mjs stays the single source), and the advanced
// handoff chars move under `advanced`.
const impl = reread.caps?.implementer;
if(!impl) throw new Error('caps.implementer missing');
if(impl.max_turns!==40 || impl.max_tokens!==180000 || impl.extra_sessions!==5 || impl.wrap_up_at_tokens!==160000) throw new Error(`implementer caps not backfilled from code defaults: ${JSON.stringify(impl)}`);
if(reread.advanced.handoff_max_chars!==2000 || reread.advanced.handoff_note_max_chars!==4000) throw new Error(`handoff chars not mapped: ${JSON.stringify(reread.advanced)}`);
if(reread.retries.no_progress_sessions!==2 || reread.retries.final_review_fix_rounds!==2) throw new Error(`retries not mapped: ${JSON.stringify(reread.retries)}`);

// Per-role caps backfilled for review roles with defaults from per-task-budget.mjs.
const caps = reread.caps;
const expectedRoles = ['planner', 'plan_reviewer', 'code_reviewer', 'verifier'];
for (const role of expectedRoles) {
  if (!caps[role]) throw new Error(`Missing caps for role ${role}`);
  const expTokens = role === 'planner' ? 200000 : role === 'plan_reviewer' ? 250000 : 150000;
  const expWrapup = role === 'planner' ? 180000 : role === 'plan_reviewer' ? 225000 : 135000;
  const expTurns = (role === "verifier" || role === "planner" || role === "plan_reviewer") ? 30 : 22; // backlog #59(b), #111
  const expSessions = role === "plan_reviewer" ? 4 : 2;
  if (caps[role].max_turns !== expTurns) throw new Error(`${role}.max_turns !== ${expTurns}: ${caps[role].max_turns}`);
  if (caps[role].max_tokens !== expTokens) throw new Error(`${role}.max_tokens !== ${expTokens}: ${caps[role].max_tokens}`);
  if (caps[role].extra_sessions !== expSessions) throw new Error(`${role}.extra_sessions !== ${expSessions}: ${caps[role].extra_sessions}`);
  if (caps[role].wrap_up_at_tokens !== expWrapup) throw new Error(`${role}.wrap_up_at_tokens !== ${expWrapup}: ${caps[role].wrap_up_at_tokens}`);
}

// Operator-set values are never overwritten.
const preset={schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{
  per_task_max_tokens:200000,
  continuation_allowance:7,
  handoff_max_chars:800,
  handoff_note_max_chars:1500,
  handoff_wrapup_tokens:60000,
  caps: {
    planner: {max_turns: 30, max_tokens: 60000, extra_sessions: 3, wrap_up_tokens_threshold: 55000},
    plan_reviewer: {max_turns: 25}
  }
}};
const presetLayout = layoutOf(preset);
if(presetLayout.caps.implementer.max_tokens!==200000 || presetLayout.caps.implementer.extra_sessions!==7 || presetLayout.caps.implementer.wrap_up_at_tokens!==60000) throw new Error(`Operator implementer caps overwritten: ${JSON.stringify(presetLayout.caps.implementer)}`);
if(presetLayout.advanced.handoff_max_chars!==800 || presetLayout.advanced.handoff_note_max_chars!==1500) throw new Error(`Operator handoff values overwritten: ${JSON.stringify(presetLayout.advanced)}`);

// Operator-set review caps are preserved; missing fields backfilled.
const presetCaps = presetLayout.caps;
if (presetCaps.planner.max_turns !== 30) throw new Error(`Operator planner.max_turns overwritten: ${presetCaps.planner.max_turns}`);
if (presetCaps.planner.max_tokens !== 60000) throw new Error(`Operator planner.max_tokens overwritten: ${presetCaps.planner.max_tokens}`);
if (presetCaps.planner.extra_sessions !== 3) throw new Error(`Operator planner.extra_sessions overwritten: ${presetCaps.planner.extra_sessions}`);
if (presetCaps.planner.wrap_up_at_tokens !== 55000) throw new Error(`Operator planner.wrap_up_at_tokens overwritten: ${presetCaps.planner.wrap_up_at_tokens}`);
if (presetCaps.plan_reviewer.max_turns !== 25) throw new Error(`Operator plan_reviewer.max_turns overwritten: ${presetCaps.plan_reviewer.max_turns}`);
if (presetCaps.plan_reviewer.max_tokens !== 250000) throw new Error(`plan_reviewer.max_tokens not backfilled to per-turn default: ${presetCaps.plan_reviewer.max_tokens}`);
if (presetCaps.plan_reviewer.extra_sessions !== 4) throw new Error(`plan_reviewer.extra_sessions not backfilled: ${presetCaps.plan_reviewer.extra_sessions}`);
if (presetCaps.plan_reviewer.wrap_up_at_tokens !== 225000) throw new Error(`plan_reviewer.wrap_up_at_tokens not backfilled to per-turn default: ${presetCaps.plan_reviewer.wrap_up_at_tokens}`);

// Mission 044 Phase 1 task 1.4: an untouched config that persisted the SHIPPED
// cumulative defaults is rewritten to the per-turn defaults (global implementer
// scale 750K/690K and review-role caps planner 1M/950K, others 500K/450K),
// while values the operator actually chose are preserved.
const legacyShipped = layoutOf({schema_version:'3.0', project:{planning_framework:'gsd'}, roles:{}, policy:{
  per_task_max_tokens:750000,
  handoff_wrapup_tokens:690000,
  caps: {
    planner: {max_tokens: 1000000, wrap_up_tokens_threshold: 950000},
    plan_reviewer: {max_tokens: 500000, wrap_up_tokens_threshold: 450000},
    code_reviewer: {max_tokens: 500000, wrap_up_tokens_threshold: 450000},
    verifier: {max_tokens: 170000, wrap_up_tokens_threshold: 160000},
  },
}});
if (legacyShipped.caps.implementer.max_tokens !== 180000) throw new Error(`legacy per_task_max_tokens 750000 not rewritten to the per-turn default: ${legacyShipped.caps.implementer.max_tokens}`);
if (legacyShipped.caps.implementer.wrap_up_at_tokens !== 160000) throw new Error(`legacy handoff_wrapup_tokens 690000 not rewritten to the per-turn default: ${legacyShipped.caps.implementer.wrap_up_at_tokens}`);
const legacyCaps = legacyShipped.caps;
for (const role of ['planner', 'plan_reviewer', 'code_reviewer']) {
  const expTokens = role === 'planner' ? 200000 : role === 'plan_reviewer' ? 250000 : 150000;
  const expWrapup = role === 'planner' ? 180000 : role === 'plan_reviewer' ? 225000 : 135000;
  if (legacyCaps[role].max_tokens !== expTokens) throw new Error(`legacy ${role}.max_tokens not rewritten: ${legacyCaps[role].max_tokens}`);
  if (legacyCaps[role].wrap_up_at_tokens !== expWrapup) throw new Error(`legacy ${role}.wrap_up_at_tokens not rewritten: ${legacyCaps[role].wrap_up_at_tokens}`);
}
// Operator values near-but-not-equal to the shipped defaults are never touched
// (170K/160K also stay valid against the rewritten 180K ceiling, so the
// backstop leaves them alone).
if (legacyCaps.verifier.max_tokens !== 170000 || legacyCaps.verifier.wrap_up_at_tokens !== 160000) throw new Error(`Operator verifier caps overwritten: ${JSON.stringify(legacyCaps.verifier)}`);

// Backlog #41 (TASK-35): idle_hang_ms backfilled fitted to the effective
// per-task deadline (never a bare default that fails validation), operator
// values kept. time_limits are minutes in v4, so compare through the runtime.
if(reread.time_limits.silent_run_minutes!==10) throw new Error(`silent_run_minutes not backfilled: ${JSON.stringify(reread.time_limits)}`);
const shortDeadline={schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{per_task_timeout_ms:300000}};
const fitted=runtimeOf(shortDeadline);
if(Math.round(fitted.policy.idle_hang_ms)!==300000-1) throw new Error(`idle_hang_ms not fitted below a short per-task deadline: ${JSON.stringify(fitted.policy)}`);
const explicitIdle={schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{idle_hang_ms:5000}};
if(Math.round(runtimeOf(explicitIdle).policy.idle_hang_ms)!==5000) throw new Error('Operator idle_hang_ms overwritten');

// A v4 config is unchanged and idempotent: no write, no backup.
if (JSON.stringify(layoutOf(reread)) !== JSON.stringify(reread)) throw new Error('v4 config was rewritten by migration');
const file2=path.join(tmp,'normalized.json'); fs.writeFileSync(file2,JSON.stringify(reread,null,2));
const same=loadAndMigrateConfig(file2,{persist:true});
if(same.changed || same.backupPath!==null) throw new Error(`Expected idempotent migration; got changed=${same.changed}`);

// Future schema must fail closed.
const future={...reread,schema_version:'99.0'};
let threw=false;
try { migrateConfig(future); } catch (err) {
  threw=true;
  if(!String(err.message).includes('newer than this Autopilot')) throw new Error(`Wrong newer-schema error: ${err.message}`);
}
if(!threw) throw new Error('Expected newer schema to throw');

// Backlog #52 final-review fix: cumulative-era values OTHER than the exact
// shipped defaults (500K/950K wrap-ups, 600K role caps) survived migration and
// failed validatePolicyConfig, so setup could not save the migrated config.
// Each must migrate to a config validatePolicyConfig accepts.
const validateMigrated = (input, label) => {
  const check = validatePolicyConfig(toRuntimeConfig(layoutOf(input)).policy);
  if (!check.valid) throw new Error(`${label}: migrated config still invalid: ${check.errors.join(' ')}`);
};
const ex500k = layoutOf({schema_version:'3.0',project:{planning_framework:'gsd'},roles:{},policy:{handoff_wrapup_tokens:500000}});
validateMigrated({schema_version:'3.0',project:{planning_framework:'gsd'},roles:{},policy:{handoff_wrapup_tokens:500000}}, '500K wrap-up');
if (ex500k.caps.implementer.wrap_up_at_tokens !== 160000) throw new Error(`500K wrap-up not rewritten to the per-turn default: ${ex500k.caps.implementer.wrap_up_at_tokens}`);
const ex950k = layoutOf({schema_version:'3.0',project:{planning_framework:'gsd'},roles:{},policy:{handoff_wrapup_tokens:950000}});
validateMigrated({schema_version:'3.0',project:{planning_framework:'gsd'},roles:{},policy:{handoff_wrapup_tokens:950000}}, '950K wrap-up');
if (ex950k.caps.implementer.wrap_up_at_tokens !== 160000) throw new Error(`950K wrap-up not rewritten to the per-turn default: ${ex950k.caps.implementer.wrap_up_at_tokens}`);
const exCapsInput = {schema_version:'3.0',project:{planning_framework:'gsd'},roles:{},policy:{per_task_max_tokens:750000, caps:{verifier:{max_tokens:600000}}}};
const exCaps = layoutOf(exCapsInput);
validateMigrated(exCapsInput, '750K cap + 600K verifier cap');
if (exCaps.caps.implementer.max_tokens !== 180000) throw new Error(`750K per_task_max_tokens not rewritten: ${exCaps.caps.implementer.max_tokens}`);
if (exCaps.caps.verifier.max_tokens !== 150000) throw new Error(`600K verifier cap not rewritten: ${exCaps.caps.verifier.max_tokens}`);

// THIS project's real config migrates and validates (read-only — never write
// config.json).
const projectConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.autopilot', 'config.json');
const projectRaw = fs.readFileSync(projectConfigPath, 'utf8');
validateMigrated(JSON.parse(projectRaw), 'project config');
if (fs.readFileSync(projectConfigPath, 'utf8') !== projectRaw) throw new Error('project config.json was modified');

// Genuine per-turn operator values (at/below the cumulative threshold) are
// kept unchanged.
const genuine = runtimeOf({schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{per_task_max_tokens:120000, handoff_wrapup_tokens:100000}});
if (genuine.policy.per_task_max_tokens !== 120000) throw new Error(`genuine per_task_max_tokens overwritten: ${genuine.policy.per_task_max_tokens}`);
if (genuine.policy.handoff_wrapup_tokens !== 100000) throw new Error(`genuine handoff_wrapup_tokens overwritten: ${genuine.policy.handoff_wrapup_tokens}`);

// Backlog #59(b): the shipped 22 turns is the old default — rewritten to 40 for
// the implementer (caps.implementer.max_turns) and 30 for the verifier; other
// values and roles whose default stays 22 are kept.
const turns = layoutOf({schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{per_task_max_turns:22, caps:{verifier:{max_turns:22}, code_reviewer:{max_turns:22}}}});
if (turns.caps.implementer.max_turns !== 40) throw new Error(`legacy per_task_max_turns 22 not rewritten: ${turns.caps.implementer.max_turns}`);
if (turns.caps.verifier.max_turns !== 30) throw new Error(`legacy verifier max_turns 22 not rewritten: ${turns.caps.verifier.max_turns}`);
if (turns.caps.code_reviewer.max_turns !== 22) throw new Error(`code_reviewer max_turns changed: ${turns.caps.code_reviewer.max_turns}`);
const turnsKept = layoutOf({schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{per_task_max_turns:25, caps:{verifier:{max_turns:18}}}});
if (turnsKept.caps.implementer.max_turns !== 25) throw new Error(`operator per_task_max_turns overwritten: ${turnsKept.caps.implementer.max_turns}`);
if (turnsKept.caps.verifier.max_turns !== 18) throw new Error(`operator verifier max_turns overwritten: ${turnsKept.caps.verifier.max_turns}`);

// Mission 051 Phase 1 task 1.1: final_review_fix_rounds backfilled when
// absent, operator values never overwritten, migrated configs validate, and
// the resolver maps unset to the default.
if (FINAL_REVIEW_FIX_ROUNDS_DEFAULT !== 2) throw new Error(`FINAL_REVIEW_FIX_ROUNDS_DEFAULT !== 2: ${FINAL_REVIEW_FIX_ROUNDS_DEFAULT}`);
const fixBackfill = runtimeOf({schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{}});
if (fixBackfill.policy.final_review_fix_rounds !== 2) throw new Error(`final_review_fix_rounds not backfilled to 2: ${fixBackfill.policy.final_review_fix_rounds}`);
const fixKept = runtimeOf({schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{final_review_fix_rounds:4}});
if (fixKept.policy.final_review_fix_rounds !== 4) throw new Error(`operator final_review_fix_rounds overwritten: ${fixKept.policy.final_review_fix_rounds}`);
const fixInvalid = validatePolicyConfig({final_review_fix_rounds: 0});
if (fixInvalid.valid) throw new Error('invalid final_review_fix_rounds 0 accepted');
if (resolveFinalReviewFixRounds({}) !== 2) throw new Error('unset config must resolve to 2');
if (resolveFinalReviewFixRounds({final_review_fix_rounds: 4}) !== 4) throw new Error('operator value 4 not preserved by resolver');
if (resolveFinalReviewFixRounds({final_review_fix_rounds: 0}) !== 2) throw new Error('invalid value must degrade to 2');
validateMigrated({schema_version:'1.4',project:{planning_framework:'gsd'},roles:{},policy:{}}, 'fix-rounds backfill');

// Operator policy.per_task_timeout_ms and policy.fallback_retry_primary_minutes
// survive migration (v3 -> v4 layout -> runtime shape).
const keptLimits = runtimeOf({schema_version:'3.0',project:{planning_framework:'gsd'},roles:{},policy:{per_task_timeout_ms:3600000, fallback_retry_primary_minutes:320}});
if (keptLimits.policy.per_task_timeout_ms !== 3600000) throw new Error(`per_task_timeout_ms lost in migration: ${keptLimits.policy.per_task_timeout_ms}`);
if (keptLimits.policy.fallback_retry_primary_minutes !== 320) throw new Error(`fallback_retry_primary_minutes lost in migration: ${keptLimits.policy.fallback_retry_primary_minutes}`);

console.log('config migration tests passed (v3→v4 layout, $schema first, operator values kept, machine fields → config.meta.json, idempotent v4)');
