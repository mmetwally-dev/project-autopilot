#!/usr/bin/env node
// Hermetic E2E for `ap config` changing a saved gate (test) command.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');

const GATES_PROMPT = /Test command \(Autopilot runs it after each phase to make sure nothing broke\):/;
const CURRENT_PROMPT = /Current: /;

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

const delimiter = process.platform === 'win32' ? ';' : ':';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemDirs = process.platform === 'win32'
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ['/usr/bin', '/bin'];

function makeFakeCliDir() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-gate-edit-fake-cli-'));
  const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeClaude, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
  } else {
    const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return binDir;
}

function baseConfig(commands) {
  const one = () => ({
    adapter: 'claude',
    model: '',
    reasoning: '',
    variant: '',
    resume: true,
    model_source: 'default',
    model_verified_at: null,
    capabilities_verified_at: null
  });
  const gates = {env_allowlist: [], require_reviewer: true, network_isolation: true};
  if (commands !== undefined) gates.commands = commands;
  return {
    schema_version: '4.0',
    project: {repo: '.', planning_framework: 'standalone', state_file: '.autopilot/state.json', runs_dir: '.autopilot/runs'},
    roles: {planner: one(), plan_reviewer: one(), implementer: one(), code_reviewer: one(), verifier: one()},
    workflow: {},
    gates,
    policy: {failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2}},
    safety: {},
    planning: {},
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: 'native', require_browser: 'when-task-requires'}},
    config_metadata: {migrated_from: '3.0', last_migrated_at: '2026-01-01T00:00:00.000Z'}
  };
}

function makeRepo(commands) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-gate-edit-'));
  const configDir = path.join(repo, '.autopilot');
  fs.mkdirSync(configDir, {recursive: true});
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(baseConfig(commands), null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({name: 'gate-edit-fixture', scripts: {test: 'node run-tests.mjs'}}, null, 2) + '\n');
  return repo;
}

function readGateCommands(repo) {
  const config = JSON.parse(fs.readFileSync(path.join(repo, '.autopilot', 'config.json'), 'utf8'));
  return config.tests?.gate_commands ?? config.gates?.commands;
}

function spawnSetup({repo, binDir, timeoutMs}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  const child = spawn(process.execPath, [setupScript, '--edit', '--repo', repo],
    {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError = null;
  let settled = false;
  const watchdog = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  const done = new Promise(resolve => {
    child.on('error', error => { spawnError = error; });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({status, signal, timedOut, error: spawnError, stdout, stderr});
    });
  });
  return {child, done, chunk: (stream, text) => { if (stream === 'out') stdout += text; else stderr += text; }, read: () => ({stdout, stderr})};
}

function runScripted({repo, binDir, answers, timeoutMs = 15000}) {
  const proc = spawnSetup({repo, binDir, timeoutMs});
  proc.child.stdout.on('data', c => proc.chunk('out', c.toString('utf8')));
  proc.child.stderr.on('data', c => proc.chunk('err', c.toString('utf8')));
  try {
    proc.child.stdin.write(answers.map(a => `${a}\n`).join(''));
    proc.child.stdin.end();
  } catch {}
  return proc.done;
}

async function runCase(name, fn) {
  console.log(`\n${name}:`);
  const started = Date.now();
  const binDir = makeFakeCliDir();
  const repos = [];
  try {
    await fn({binDir, makeRepo: opts => { const r = makeRepo(opts); repos.push(r); return r; }});
  } catch (error) {
    failed++;
    console.log(`  ✗ case threw: ${error?.stack || error}`);
  } finally {
    for (const repo of repos) try { fs.rmSync(repo, {recursive: true, force: true}); } catch {}
    try { fs.rmSync(binDir, {recursive: true, force: true}); } catch {}
    const elapsed = Date.now() - started;
    check(`${name}: under 10s`, elapsed < 10000, `${elapsed} ms`);
    console.log(`  (${elapsed} ms)`);
  }
}

const overallStarted = Date.now();
const SAVED = ['node scripts/test-all.mjs --skip-live'];

// 1. saved + Enter keeps it
await runCase('saved + Enter keeps', async ({binDir, makeRepo}) => {
  const repo = makeRepo(SAVED);
  const r = await runScripted({repo, binDir, answers: ['3', '']});
  const combined = `${r.stdout}\n${r.stderr}`;
  check('setup completed', r.status === 0 && !r.timedOut && !r.error, `status=${r.status}`);
  check('prints Current:', CURRENT_PROMPT.test(combined), combined.slice(-1500));
  check('prints gates prompt', GATES_PROMPT.test(combined));
  checkEqual('keeps saved value', readGateCommands(repo), SAVED);
});

// 2. saved + typed replaces
await runCase('saved + typed replaces', async ({binDir, makeRepo}) => {
  const repo = makeRepo(SAVED);
  const r = await runScripted({repo, binDir, answers: ['3', 'npm run test:unit']});
  const combined = `${r.stdout}\n${r.stderr}`;
  check('setup completed', r.status === 0 && !r.timedOut && !r.error, `status=${r.status}`);
  check('prints Current:', CURRENT_PROMPT.test(combined));
  checkEqual('replaces with typed command', readGateCommands(repo), ['npm run test:unit']);
});

// 3. saved + "-" clears
await runCase('saved + "-" clears', async ({binDir, makeRepo}) => {
  const repo = makeRepo(SAVED);
  const r = await runScripted({repo, binDir, answers: ['3', '-']});
  const combined = `${r.stdout}\n${r.stderr}`;
  check('setup completed', r.status === 0 && !r.timedOut && !r.error, `status=${r.status}`);
  check('prints Current:', CURRENT_PROMPT.test(combined));
  checkEqual('clears to empty', readGateCommands(repo), []);
});

// 4. first-run wizard shows Found:
await runCase('wizard shows Found:', async ({binDir, makeRepo}) => {
  const repo = makeRepo([]);
  try { fs.rmSync(path.join(repo, '.autopilot'), {recursive: true, force: true}); } catch {}
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  const child = spawn(process.execPath, [setupScript, '--wizard', '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const done = new Promise(resolve => child.on('close', s => resolve(s)));
  child.stdin.write(['', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', ''].map(a => `${a}\n`).join(''));
  child.stdin.end();
  const status = await done;
  check('wizard exits 0', status === 0, `status=${status}\n${out.slice(-1500)}`);
  check('wizard shows Found:', /Found: npm test/.test(out), out.slice(-1500));
});

// 5. first-run wizard shows None found:
await runCase('wizard shows None found:', async ({binDir}) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-gate-edit-wiz-'));
  try {
    const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
    const child = spawn(process.execPath, [setupScript, '--wizard', '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const done = new Promise(resolve => child.on('close', s => resolve(s)));
    child.stdin.write(['', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', ''].map(a => `${a}\n`).join(''));
    child.stdin.end();
    const status = await done;
    check('wizard exits 0', status === 0, `status=${status}\n${out.slice(-1500)}`);
    check('wizard shows None found:', /None found\./.test(out), out.slice(-1500));
  } finally {
    try { fs.rmSync(repo, {recursive: true, force: true}); } catch {}
  }
});

const totalElapsed = Date.now() - overallStarted;
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${totalElapsed} ms total)`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
