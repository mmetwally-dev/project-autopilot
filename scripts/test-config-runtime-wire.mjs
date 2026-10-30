#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAndMigrateConfig } from './config-migration.mjs';
import { toRuntimeConfig } from './config-layout.mjs';

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ''}`);
  failed += 1;
}

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-runtime-wire-'));
tempDirs.add(tmp);
const file = path.join(tmp, 'config.json');

const v4 = {
  $schema: './config.schema.json',
  schema_version: '4.0',
  project: { repo: '.', planning_framework: 'standalone' },
  roles: {
    planner: { cli: 'claude', model: 'opus', reasoning: 'high', variant: '', resume_session: true, fallbacks: [] },
    plan_reviewer: { cli: 'codex', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    implementer: { cli: 'claude', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    code_reviewer: { cli: 'codex', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    verifier: { cli: 'claude', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    free_models: { auto_fallback: true, max_turns: 10 },
  },
  caps: {
    task_size_target_turns: 12,
    planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
    plan_reviewer: { max_turns: 30, max_tokens: 150000, extra_sessions: 4, wrap_up_at_tokens: 135000 },
    implementer: { max_turns: 40, max_tokens: 180000, extra_sessions: 5, wrap_up_at_tokens: 160000 },
    code_reviewer: { max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    verifier: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    mission_token_backstop: 6000000,
  },
  retries: { plan_revisions: 8, implementation: 4, verification: 4, final_review_fix_rounds: 2, cli_errors: 3, infrastructure: 3, no_progress_sessions: 2, extra_sessions_per_task: 5 },
  time_limits: { call_backstop_minutes: 160, silent_run_minutes: 10 },
  workflow: { plan_review: true, commit_by_human: true },
  tests: { gate_commands: [], gate_network: false, require_reviewer: true },
  safety: { allow_git_commit: false, stop_on_sandbox_violation: true },
  runtime: { mode: 'linux-strong', wsl_distro: null },
  frameworks: {},
  advanced: { state_file: '.autopilot/state.json', runs_dir: '.autopilot/runs', handoff_max_chars: 2000 },
};

// persist:false -> file byte-identical
fs.writeFileSync(file, JSON.stringify(v4, null, 2) + '\n');
const before = fs.readFileSync(file);
const r0 = loadAndMigrateConfig(file, { persist: false });
const after0 = fs.readFileSync(file);
check('persist:false returns a result', !!r0);
check('persist:false file byte-identical', Buffer.compare(before, after0) === 0);
check('persist:false layout present', !!r0.layout);
check('persist:false config present', !!r0.config);
check('persist:false config.policy.caps present', !!r0.config?.policy?.caps);
check('persist:false config.policy.per_task_max_turns', r0.config?.policy?.per_task_max_turns === 40);
check('persist:false config.policy.per_task_max_tokens', r0.config?.policy?.per_task_max_tokens === 180000);
for (const role of ['planner', 'plan_reviewer', 'implementer', 'code_reviewer', 'verifier']) {
  check(`persist:false config.roles.${role}.adapter`, r0.config?.roles?.[role]?.adapter === v4.roles[role].cli);
}

// persist:true -> v4 persisted (run on a fresh pre-v4 file to exercise the write)
const file2 = path.join(tmp, 'config2.json');
const legacy = { schema_version: '1.4', project: { planning_framework: 'gsd' }, roles: { planner: { adapter: 'claude', model: 'opus' } } };
fs.writeFileSync(file2, JSON.stringify(legacy, null, 2) + '\n');
const r1 = loadAndMigrateConfig(file2, { persist: true });
const persisted = JSON.parse(fs.readFileSync(file2, 'utf8'));
check('persist:true changed', r1.changed === true);
check('persist:true persisted v4 schema', persisted.schema_version === '4.0');
check('persist:true persisted $schema first', Object.keys(persisted)[0] === '$schema');
check('persist:true config.policy.caps present', !!r1.config?.policy?.caps);
check('persist:true config.policy.per_task_max_turns', typeof r1.config?.policy?.per_task_max_turns === 'number');
check('persist:true config.policy.per_task_max_tokens', typeof r1.config?.policy?.per_task_max_tokens === 'number');
check('persist:true config.roles.planner.adapter', r1.config?.roles?.planner?.adapter === 'claude');
check('persist:true layout present', !!r1.layout);

// persist:true on an already-v4 file is idempotent (no write/backup)
const before2 = fs.readFileSync(file);
const r2 = loadAndMigrateConfig(file, { persist: true });
const after2 = fs.readFileSync(file);
check('persist:true idempotent file byte-identical', Buffer.compare(before2, after2) === 0);
check('persist:true idempotent changed false', r2.changed === false);
check('persist:true idempotent backup null', r2.backupPath === null);

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
