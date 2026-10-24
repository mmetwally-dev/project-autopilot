#!/usr/bin/env node
// Mission 031 task 1.5: setup writes policy.caps for the four review roles.
// Part 1 checks the real merge (mergeRoleCaps, the function setup.mjs calls).
// Part 2 runs setup.mjs itself through a hermetic PATH holding a fake `claude`
// and asserts the caps it writes to .autopilot/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {delimiter} from 'node:path';
import {mergeRoleCaps} from './per-task-budget.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');
const reviewRoles = ['planner', 'plan_reviewer', 'code_reviewer', 'verifier'];
// Legacy format (from mergeRoleCaps) uses wrap_up_tokens_threshold
const LEGACY_DEFAULTS = {max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_tokens_threshold: 135000};
const LEGACY_PLANNER_DEFAULTS = {max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_tokens_threshold: 180000};
const LEGACY_VERIFIER_DEFAULTS = {...LEGACY_DEFAULTS, max_turns: 30};
const legacyDefaultsFor = (role) => (role === "planner" ? LEGACY_PLANNER_DEFAULTS : (role === "verifier" || role === "plan_reviewer") ? LEGACY_VERIFIER_DEFAULTS : LEGACY_DEFAULTS);
// v4 format (from toNewLayoutConfig) uses wrap_up_at_tokens
const V4_DEFAULTS = {max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000};
const V4_PLANNER_DEFAULTS = {max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000};
const V4_VERIFIER_DEFAULTS = {...V4_DEFAULTS, max_turns: 30};
const V4_IMPLEMENTER_DEFAULTS = {max_turns: 40, max_tokens: 180000, extra_sessions: 5, wrap_up_at_tokens: 160000};
const v4DefaultsFor = (role) => (role === "planner" ? V4_PLANNER_DEFAULTS : (role === "verifier" || role === "plan_reviewer") ? V4_VERIFIER_DEFAULTS : (role === "implementer" ? V4_IMPLEMENTER_DEFAULTS : V4_DEFAULTS));

let passed = 0;
let failed = 0;
function checkEqual(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- Part 1: mergeRoleCaps (legacy format with wrap_up_tokens_threshold) ----

// First run: no caps -> every review role gets all defaults, implementer absent.
{
  const caps = mergeRoleCaps({});
  for (const role of reviewRoles) checkEqual(`first run ${role}`, caps[role], legacyDefaultsFor(role));
  checkEqual('first run: implementer absent', 'implementer' in caps, false);
}

// Partial operator caps: set fields win, gaps filled per field.
{
  const caps = mergeRoleCaps({
    planner: {max_turns: 30},
    code_reviewer: {extra_sessions: 5, wrap_up_tokens_threshold: 400000}
  });
  checkEqual('partial planner', caps.planner, {...LEGACY_PLANNER_DEFAULTS, max_turns: 30});
  checkEqual('partial code_reviewer', caps.code_reviewer, {...LEGACY_DEFAULTS, extra_sessions: 5, wrap_up_tokens_threshold: 400000});
  checkEqual('partial verifier default', caps.verifier, LEGACY_VERIFIER_DEFAULTS);
}

// Full operator caps for one role are kept as-is.
{
  const full = {max_turns: 15, max_tokens: 200000, extra_sessions: 3, wrap_up_tokens_threshold: 180000};
  const caps = mergeRoleCaps({verifier: full});
  checkEqual('full verifier kept', caps.verifier, full);
  checkEqual('full: planner default', caps.planner, LEGACY_PLANNER_DEFAULTS);
}

// Non-review entries are kept untouched; input is not mutated.
{
  const input = {custom_role: {max_turns: 10}, planner: {max_turns: 30}};
  const snapshot = JSON.stringify(input);
  const caps = mergeRoleCaps(input);
  checkEqual('custom_role kept', caps.custom_role, {max_turns: 10});
  checkEqual('input not mutated', JSON.stringify(input), snapshot);
}

// Mission 044 Phase 1 task 1.4: shipped cumulative defaults are rewritten to
// the per-turn defaults, genuine operator values are preserved.
{
  const legacy = mergeRoleCaps({plan_reviewer: {max_tokens: 500000, wrap_up_tokens_threshold: 450000}});
  checkEqual('legacy review caps rewritten to per-turn defaults', legacy.plan_reviewer, {...LEGACY_DEFAULTS, max_turns: 30});
  const legacyPlanner = mergeRoleCaps({planner: {max_tokens: 1000000, wrap_up_tokens_threshold: 950000}});
  checkEqual('legacy planner caps rewritten to per-turn defaults', legacyPlanner.planner, LEGACY_PLANNER_DEFAULTS);
  const kept = mergeRoleCaps({plan_reviewer: {max_tokens: 300000, wrap_up_tokens_threshold: 450000}});
  checkEqual('operator max_tokens 300K kept, legacy wrap-up rewritten', kept.plan_reviewer, {...LEGACY_DEFAULTS, max_turns: 30, max_tokens: 300000});
}

// ---- Part 2: setup.mjs end to end ----

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemDirs = process.platform === 'win32'
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ['/usr/bin', '/bin'];
const tmpDirs = [];

function makeFakeCliDir() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-caps-fake-cli-'));
  tmpDirs.push(binDir);
  const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeClaude, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
  } else {
    // A shebang script named `claude` is rejected as an npm-style shim, so the
    // fake CLI is a copy of a real ELF (`true`).
    const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return binDir;
}

function baseConfig(caps) {
  const one = () => ({
    adapter: 'claude', model: '', reasoning: '', variant: '', resume: true,
    model_source: 'default', model_verified_at: null, capabilities_verified_at: null
  });
  const policy = {
    failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2}
  };
  if (caps !== undefined) policy.caps = caps;
  return {
    schema_version: '3.0',
    project: {repo: '.', planning_framework: 'standalone', state_file: '.autopilot/state.json', runs_dir: '.autopilot/runs'},
    roles: {planner: one(), plan_reviewer: one(), implementer: one(), code_reviewer: one(), verifier: one()},
    workflow: {},
    gates: {env_allowlist: [], require_reviewer: true, network_isolation: true, commands: []},
    policy,
    safety: {},
    planning: {},
    capabilities: {
      project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false,
      verification: {browser: 'native', require_browser: 'when-task-requires'}
    },
    config_metadata: {migrated_from: '3.0', last_migrated_at: '2026-01-01T00:00:00.000Z'}
  };
}

function makeRepo(caps) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-caps-setup-'));
  tmpDirs.push(repo);
  fs.mkdirSync(path.join(repo, '.autopilot'), {recursive: true});
  fs.writeFileSync(path.join(repo, '.autopilot', 'config.json'), JSON.stringify(baseConfig(caps), null, 2) + '\n');
  return repo;
}

// Scope "3" (Framework / safety), empty gates answer; the single framework
// choice (standalone) is selected without a question.
function runSetup(repo, binDir) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupScript, '--edit', '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 20000);
    child.on('close', status => { clearTimeout(watchdog); resolve({status, out}); });
    child.stdin.write(['3', ''].map(a => `${a}\n`).join(''));
    child.stdin.end();
  });
}

function readCaps(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.autopilot', 'config.json'), 'utf8')).caps;
}

try {
  const binDir = makeFakeCliDir();

  // First run: config has no caps -> setup writes all defaults.
  {
    const repo = makeRepo(undefined);
    const r = await runSetup(repo, binDir);
    checkEqual('setup first run exit status', r.status, 0);
    if (r.status !== 0) console.error(r.out.slice(-2000));
    const caps = readCaps(repo) || {};
    for (const role of reviewRoles) checkEqual(`setup first run ${role}`, caps[role], v4DefaultsFor(role));
    checkEqual('setup first run implementer', caps.implementer, V4_IMPLEMENTER_DEFAULTS);
  }

  // Existing partial + full caps are preserved, gaps filled. (An unknown key
  // under caps is rejected by config validation, so it is not seeded.)
  // Non-planner review roles must have max_tokens < global ceiling (180K).
  {
    const full = {max_turns: 15, max_tokens: 150000, extra_sessions: 3, wrap_up_at_tokens: 135000};
    const repo = makeRepo({planner: {max_turns: 30}, verifier: full});
    const r = await runSetup(repo, binDir);
    checkEqual('setup existing exit status', r.status, 0);
    if (r.status !== 0) console.error(r.out.slice(-2000));
    const caps = readCaps(repo) || {};
    checkEqual('setup partial planner', caps.planner, {...V4_PLANNER_DEFAULTS, max_turns: 30});
    checkEqual('setup full verifier', caps.verifier, full);
    checkEqual('setup default plan_reviewer', caps.plan_reviewer, {...V4_DEFAULTS, max_turns: 30});
    checkEqual('setup default code_reviewer', caps.code_reviewer, V4_DEFAULTS);
    checkEqual('setup implementer unchanged', caps.implementer, V4_IMPLEMENTER_DEFAULTS);
  }
} finally {
  for (const dir of tmpDirs) fs.rmSync(dir, {recursive: true, force: true});
}

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
