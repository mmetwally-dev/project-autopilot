#!/usr/bin/env node
// Hermetic regression for backlog #1 (ap config / setup model handling):
//
//   (a) a configured model (primary, fallback, or escalation) that vanished
//       from the CLI's live list must NOT abort setup — setup lists the
//       affected entries with the currently available models and offers an
//       in-place re-pick/drop, then continues and saves.
//   (b) the canonical live id is persisted, never the operator's/display
//       casing (case-insensitive canonicalisation).
//   (c) a replacement model that does not support a carried-forward
//       reasoning/variant value clears it instead of saving an invalid pair.
//   (d) a run that ends with a failed final validation leaves config.json
//       byte-identical on disk (migration no longer writes on load), and a
//       successful migrated save still records its backup.
//
// Plus the `ap run` preflight warn-only path for OpenCode models missing from
// the live/shared-cache list.
//
// setup.mjs runs as a subprocess through a hermetic PATH holding fake CLIs
// (the copy-of-`true` ELF pattern for claude, and a deterministic fake
// opencode that reports a live model list), so no real agent CLI and no
// network is ever touched. Interactive cases use
// AUTOPILOT_SETUP_FORCE_INTERACTIVE=1 (positional stdin answers).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalModelId} from './model-discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');
const setupSource = fs.readFileSync(setupScript, 'utf8');

const delimiter = process.platform === 'win32' ? ';' : ':';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemDirs = process.platform === 'win32'
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ['/usr/bin', '/bin'];

let passed = 0;
let failed = 0;

function check(caseName, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${caseName}`);
  } else {
    failed++;
    console.log(`  ✗ ${caseName}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function checkEqual(caseName, actual, expected) {
  check(caseName, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Fake CLIs
// ---------------------------------------------------------------------------

function makeClaudeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-mmr-claude-'));
  const fake = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(fake, '@echo off\nexit /b 0\n');
  } else {
    const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
    fs.copyFileSync(realTrue, fake);
    fs.chmodSync(fake, 0o755);
  }
  return binDir;
}

// A deterministic fake opencode: --version/--help succeed, `models --verbose`
// fails (so the plain `models` path is used) and `models` prints the live ids.
function makeOpenCodeBin(models = ['opencode/mimo-v2.6-flash-free', 'opencode/glm-5.3-flash-free']) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-mmr-opencode-'));
  const server = path.join(binDir, 'fake-opencode.mjs');
  fs.writeFileSync(server, [
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
    'if (a[0] === "--help") { process.stdout.write("Usage: opencode\\n  -m, --model <name>\\n"); process.exit(0); }',
    'if (a[0] === "run" && a[1] === "--help") { process.stdout.write("Usage: opencode run\\n      --variant  model variant (provider-specific reasoning effort, e.g., high, max, minimal)\\n"); process.exit(0); }',
    'if (a[0] === "models" && a[1] === "--verbose") { process.exit(1); }',
    `if (a[0] === "models") { process.stdout.write(${JSON.stringify(models.join('\n') + '\n')}); process.exit(0); }`,
    'process.exit(0);'
  ].join('\n'));
  let binary;
  if (process.platform === 'win32') {
    binary = path.join(binDir, 'opencode.cmd');
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`);
  } else {
    binary = path.join(binDir, 'opencode');
    fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
    fs.chmodSync(binary, 0o755);
  }
  return binDir;
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-mmr-repo-'));
}

const ROLE_TEMPLATE = () => ({
  cli: 'claude',
  model: '',
  reasoning: '',
  variant: '',
  resume_session: true,
  model_source: 'default',
  model_verified_at: null,
  capabilities_verified_at: null
});

function baseConfig({schema = '4.0', fallbacks} = {}) {
  const roles = {
    planner: ROLE_TEMPLATE(),
    plan_reviewer: ROLE_TEMPLATE(),
    implementer: ROLE_TEMPLATE(),
    code_reviewer: ROLE_TEMPLATE(),
    verifier: ROLE_TEMPLATE()
  };
  if (fallbacks) {
    for (const [role, list] of Object.entries(fallbacks)) {
      roles[role].fallbacks = list;
    }
  }
  return {
    schema_version: schema,
    project: {
      repo: '.',
      planning_framework: 'standalone',
      state_file: '.autopilot/state.json',
      runs_dir: '.autopilot/runs'
    },
    roles,
    workflow: {},
    gates: {env_allowlist: [], require_reviewer: true, network_isolation: true, commands: []},
    policy: {
      failure_budgets: {
        implementationFailureBudget: 3,
        verificationFailureBudget: 3,
        adapterRetryBudget: 2,
        infrastructureRetryBudget: 2
      }
    },
    safety: {},
    planning: {},
    capabilities: {
      project_defaults: [],
      role_requirements: {},
      safety_denied: [],
      legacy_text_inference: false,
      verification: {browser: 'native', require_browser: 'when-task-requires'}
    },
    config_metadata: {}
  };
}

function seedRepo(config) {
  const repo = makeRepo();
  const configDir = path.join(repo, '.autopilot');
  fs.mkdirSync(configDir, {recursive: true});
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return repo;
}

function configPath(repo) {
  return path.join(repo, '.autopilot', 'config.json');
}

function readConfig(repo) {
  return JSON.parse(fs.readFileSync(configPath(repo), 'utf8'));
}

function backupFiles(repo) {
  const dir = path.dirname(configPath(repo));
  return fs.readdirSync(dir).filter(f => /^config\.json\.bak-/.test(f));
}

function spawnSetup({repo, binDir, forceInteractive, timeoutMs}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter)};
  if (forceInteractive) {
    env.AUTOPILOT_SETUP_FORCE_INTERACTIVE = '1';
  } else {
    delete env.AUTOPILOT_SETUP_FORCE_INTERACTIVE;
  }
  const child = spawn(process.execPath, [setupScript, '--edit', '--repo', repo],
    {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError = null;
  let settled = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  const done = new Promise(resolve => {
    child.on('error', error => { spawnError = error; });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({status, signal, timedOut, error: spawnError, stdout, stderr});
    });
  });
  return {
    child,
    done,
    chunk: (stream, text) => { if (stream === 'out') stdout += text; else stderr += text; }
  };
}

function runScripted({repo, binDir, answers, timeoutMs = 20000}) {
  const proc = spawnSetup({repo, binDir, forceInteractive: true, timeoutMs});
  proc.child.stdout.on('data', c => proc.chunk('out', c.toString('utf8')));
  proc.child.stderr.on('data', c => proc.chunk('err', c.toString('utf8')));
  try {
    proc.child.stdin.write(answers.map(a => `${a}\n`).join(''));
    proc.child.stdin.end();
  } catch { /* child already gone */ }
  return proc.done;
}

// --edit answer prefix: scope, framework, (adapter <default>, Keep-menu) x 5,
// gate command. `tail` appends the post-validation repair answers.
function editAnswers(tail = []) {
  const out = ['1', '1'];
  for (let i = 0; i < 5; i++) out.push('', '1');
  out.push('');
  return [...out, ...tail];
}

function combine(r) {
  return `${r.stdout}\n${r.stderr}`;
}

// ---------------------------------------------------------------------------
// Part 1 — canonicalModelId() unit: case-insensitive against ids and
// effortModelIds, pass-through otherwise.
// ---------------------------------------------------------------------------
{
  console.log('\ncanonicalModelId:');
  const catalog = [
    {id: 'opencode/mimo-v2.6-flash-free', effortModelIds: {}},
    {id: 'opencode/deepseek-v4.1-flash-free', effortModelIds: {low: 'opencode/deepseek-v4.1-flash-free-low', high: 'opencode/deepseek-v4.1-flash-free-high'}}
  ];
  checkEqual('display case normalised to the live id',
    canonicalModelId('opencode/MiMo-V2.6-Flash-Free', catalog), 'opencode/mimo-v2.6-flash-free');
  checkEqual('effort-mapped id normalised via effortModelIds',
    canonicalModelId('opencode/DeepSeek-V4.1-Flash-Free-High', catalog), 'opencode/deepseek-v4.1-flash-free-high');
  checkEqual('exact id returned unchanged', canonicalModelId('opencode/mimo-v2.6-flash-free', catalog), 'opencode/mimo-v2.6-flash-free');
  checkEqual('unknown id passes through', canonicalModelId('opencode/ghost-free', catalog), 'opencode/ghost-free');
  checkEqual('empty stays empty', canonicalModelId('', catalog), '');
}

// ---------------------------------------------------------------------------
// Part 2 — validateRoleSelection() reports a structured, target-tagged
// missingModels list (the contract the setup repair loop consumes).
// ---------------------------------------------------------------------------
{
  console.log('\nvalidateRoleSelection missingModels:');
  const binDir = makeOpenCodeBin();
  const savedPath = process.env.PATH;
  process.env.PATH = [binDir, ...systemDirs].join(delimiter);
  try {
    const {validateRoleSelection} = await import('./config-validation.mjs');
    const agents = JSON.parse(fs.readFileSync(path.join(root, 'adapters', 'agents.json'), 'utf8')).adapters;

    const empty = () => ({adapter: 'opencode', model: '', reasoning: '', variant: ''});

    const fallbackOnly = await validateRoleSelection({
      roleName: 'planner',
      role: {...empty(), fallbacks: [{adapter: 'opencode', model: 'opencode/MiMo-V2.6-Flash-Free'}]},
      adapter: agents.opencode,
      agents
    });
    check('a display-case fallback is flagged missing', fallbackOnly.missingModels.length === 1,
      JSON.stringify(fallbackOnly.missingModels));
    checkEqual('the flag names model/adapter/kind/index',
      fallbackOnly.missingModels[0],
      {model: 'opencode/MiMo-V2.6-Flash-Free', adapter: 'opencode', kind: 'fallback', index: 0});

    const primaryAndEscalation = await validateRoleSelection({
      roleName: 'planner',
      role: {
        ...empty(),
        model: 'opencode/ghost-primary-free',
        escalation_model: {adapter: 'opencode', model: 'opencode/ghost-escalation-free', reasoning: '', variant: ''}
      },
      adapter: agents.opencode,
      agents
    });
    const kinds = primaryAndEscalation.missingModels.map(m => m.kind).sort();
    checkEqual('primary and escalation entries are both flagged', kinds, ['escalation', 'primary']);

    const present = await validateRoleSelection({
      roleName: 'planner',
      role: {...empty(), model: 'opencode/mimo-v2.6-flash-free'},
      adapter: agents.opencode,
      agents
    });
    check('a live model is not flagged', present.missingModels.length === 0 && present.valid,
      JSON.stringify({missing: present.missingModels, errors: present.errors}));
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Part 3 — ap run preflight warn-only path: every OpenCode role entry
// (primary/fallback/escalation) missing from the shared-cache catalog warns;
// non-OpenCode adapters and present models do not.
// ---------------------------------------------------------------------------
{
  console.log('\nopenCodeSandboxModelWarnings:');
  const {openCodeSandboxModelWarningsForTests: warn} = await import('./autopilot.mjs');
  const catalog = new Set(['kept-free']);
  const warnings = warn({
    planner: {adapter: 'opencode', model: 'opencode/kept-free'},
    implementer: {
      adapter: 'opencode',
      model: 'opencode/gone-primary-free',
      fallbacks: [{adapter: 'opencode', model: 'opencode/gone-fallback-free'}],
      escalation_model: {adapter: 'opencode', model: 'opencode/gone-escalation-free'}
    },
    verifier: {adapter: 'codex', model: 'gpt-5'}
  }, catalog);
  const joined = warnings.join('\n');
  check('a present model produces no warning', !joined.includes('kept-free'));
  check('a non-OpenCode role is ignored', !joined.includes('verifier'));
  check('missing primary is warned', joined.includes('opencode/gone-primary-free') && joined.includes('implementer'));
  check('missing fallback is warned', joined.includes('opencode/gone-fallback-free'));
  check('missing escalation model is warned', joined.includes('opencode/gone-escalation-free'));
  checkEqual('one warning per missing model id', warnings.length, 3);
  checkEqual('an absent catalog yields no warnings',
    warn({planner: {adapter: 'opencode', model: 'opencode/whatever'}}, null), []);
}

// ---------------------------------------------------------------------------
// Part 4 — source guardrails (regression-proof wiring).
// ---------------------------------------------------------------------------
{
  console.log('\nsource wiring:');
  check('setup loads/migrates WITHOUT persisting on load', /loadAndMigrateConfig\([\s\S]{0,120}?persist:\s*false/.test(setupSource));
  check('setup backs the config up at the save point', /existingResult\.backupPath\s*=\s*`\$\{out\}\.bak-/.test(setupSource));
  check('setup consumes missingModels for in-place repair', /repairMissingModels[\s\S]*missingModels/.test(setupSource));
  check('setup canonicalises the live pick', /model:\s*canonicalModelId\(item\.id/.test(setupSource));
  check('preflight runs the OpenCode missing-model warnings', /openCodeSandboxModelWarnings\(c\.roles\)/.test(
    fs.readFileSync(path.join(here, 'autopilot.mjs'), 'utf8')));
}

// ---------------------------------------------------------------------------
// Part 5 — end-to-end `ap config` repair: a vanished fallback model is
// re-picked in place, the canonical live id is saved, and the migrated
// config is written with a backup.
// ---------------------------------------------------------------------------
{
  console.log('\nsetup --edit repairs a missing fallback in place:');
  const binDir = makeClaudeBin();
  const ocBin = makeOpenCodeBin();
  const repo = seedRepo(baseConfig({
    schema: '2.0',
    fallbacks: {planner: [{cli: 'opencode', model: 'opencode/MiMo-V2.6-Flash-Free'}]}
  }));
  const original = fs.readFileSync(configPath(repo), 'utf8');
  try {
    const r = await runScripted({
      repo,
      binDir: [binDir, ocBin].join(delimiter),
      answers: editAnswers(['1'])
    });
    const combined = combine(r);
    check('setup completed instead of aborting', r.status === 0 && !r.timedOut && !r.error,
      `status=${r.status} timedOut=${r.timedOut} error=${r.error}\n${combined.slice(-1200)}`);
    check('the vanished model is named with the affected entry', /Model no longer available: Planner fallback 1/.test(combined),
      combined.slice(-1500));
    check('the live models are offered', /opencode\/mimo-v2\.6-flash-free/.test(combined), combined.slice(-1500));
    check('a re-pick is saved', /Planner fallback 1: set to opencode\/mimo-v2\.6-flash-free/.test(combined),
      combined.slice(-800));
    checkEqual('the canonical live id is persisted',
      readConfig(repo).roles.planner.fallbacks[0].model, 'opencode/mimo-v2.6-flash-free');
    check('the migrated save records a backup', backupFiles(repo).length === 1, JSON.stringify(backupFiles(repo)));
    check('the file on disk actually changed', fs.readFileSync(configPath(repo), 'utf8') !== original);
  } catch (error) {
    failed++;
    console.log(`  ✗ case threw: ${error?.stack || error}`);
  } finally {
    for (const dir of [binDir, ocBin, repo]) {
      try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Part 6 — a failed final validation (non-repairable error) leaves the
// config byte-identical and writes no backup.
// ---------------------------------------------------------------------------
{
  console.log('\nsetup --edit does not touch config on failed validation:');
  const binDir = makeClaudeBin();
  const repo = seedRepo(baseConfig({schema: '2.0', fallbacks: {planner: [{cli: 'bogus', model: 'x'}]}}));
  const original = fs.readFileSync(configPath(repo), 'utf8');
  try {
    const r = await runScripted({repo, binDir, answers: editAnswers([])});
    const combined = combine(r);
    check('setup aborts with the validation exit code', r.status === 4, `status=${r.status}\n${combined.slice(-1200)}`);
    check('validation failure is reported', /Configuration validation failed/.test(combined), combined.slice(-1200));
    check('no backup is written for a run that never saved', backupFiles(repo).length === 0, JSON.stringify(backupFiles(repo)));
    check('config.json is byte-identical', fs.readFileSync(configPath(repo), 'utf8') === original);
  } catch (error) {
    failed++;
    console.log(`  ✗ case threw: ${error?.stack || error}`);
  } finally {
    for (const dir of [binDir, repo]) {
      try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best effort */ }
    }
  }
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
