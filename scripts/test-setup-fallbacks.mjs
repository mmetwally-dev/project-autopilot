#!/usr/bin/env node
// Hermetic end-to-end for setup's per-role fallback question (backlog #88,
// phase 2): the optional fallback loop is wizard-gated, defaults to No, and
// appends new picks after any copied-forward prior entries.
//
// setup.mjs runs as a subprocess through a hermetic PATH holding fake CLIs
// (the copy-of-`true` ELF pattern from test-setup-first-run-e2e.mjs), so no
// real agent CLI and no network is ever touched.
//
// Interactive cases run with AUTOPILOT_SETUP_FORCE_INTERACTIVE=1, which makes
// setup read its whole answer block from stdin up front (no readline
// involved) and answer positionally. With only fake `claude`/`codex`
// installed, capabilities report model=no/effort=no/variant=no, so each role
// consumes exactly two answers (adapter choose, fallback No/Yes choose) plus
// two answers per fallback pick (fallback adapter choose, add-another
// choose); the wizard run is: continue, (adapter, fallback) x 5, planning
// framework, gates command. The non-TTY case must NOT set that variable:
// setup then talks to a piped stdin through readline, answers are written
// only in response to newly observed prompt output (same driver as
// test-setup-gates-flow.mjs) and stdin is never closed, so a prompt that
// should not exist would hang the run into the watchdog instead of being
// silently answered.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');

const FALLBACK_PROMPT = /Add a fallback for /;
const CURRENT_LIST = /Current fallbacks:/;
const REVIEWER_HINT = /reviewer independence/;
const QUOTA_HINT = /uses Claude plan quota/;
const PAID_HINT = /may be paid/;
const REVIEWER_WARNING = /reviewer independence requires a different model/;
const PROMPT_TAIL = /: $|Press Enter[^\n]*\s$/;

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

function makeFakeCliDir(names = ['claude']) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fallbacks-fake-cli-'));
  for (const name of names) {
    const fake = path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
    if (process.platform === 'win32') {
      fs.writeFileSync(fake, '@echo off\nif "%1"=="--version" (echo fake-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
    } else {
      // A plain shebang script is rejected by adapter-drivers.mjs as an
      // npm-style Windows launcher shim, so the fake CLI is a copy of a real
      // ELF (`true`): classified `native`, admitted, exit status 0.
      const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
      fs.copyFileSync(realTrue, fake);
      fs.chmodSync(fake, 0o755);
    }
  }
  return binDir;
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fallbacks-flow-'));
}

// Minimal but complete and validation-clean config: roles already point at
// the fake `claude` with no model selection (so validation cannot raise an
// unverified-model confirmation), and no execution block (setup auto-selects
// the single available strong runtime mode without asking).
function baseConfig({fallbacks} = {}) {
  const one = () => ({
    cli: 'claude',
    model: '',
    reasoning: '',
    variant: '',
    resume_session: true,
    model_source: 'default',
    model_verified_at: null,
    capabilities_verified_at: null
  });
  const roles = {
    planner: one(),
    plan_reviewer: one(),
    implementer: one(),
    code_reviewer: one(),
    verifier: one()
  };
  if (fallbacks) {
    for (const [role, list] of Object.entries(fallbacks)) {
      roles[role].fallbacks = list;
    }
  }
  return {
    schema_version: '4.0',
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
    config_metadata: {migrated_from: '3.0', last_migrated_at: '2026-01-01T00:00:00.000Z'}
  };
}

function seedRepo(config) {
  const repo = makeRepo();
  const configDir = path.join(repo, '.autopilot');
  fs.mkdirSync(configDir, {recursive: true});
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return repo;
}

function readConfig(repo) {
  const file = path.join(repo, '.autopilot', 'config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function spawnSetup({mode, repo, binDir, forceInteractive, timeoutMs}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter)};
  if (forceInteractive) {
    env.AUTOPILOT_SETUP_FORCE_INTERACTIVE = '1';
  } else {
    delete env.AUTOPILOT_SETUP_FORCE_INTERACTIVE;
  }
  const child = spawn(process.execPath, [setupScript, mode, '--repo', repo],
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
  return {child, done, chunk: (stream, text) => { if (stream === 'out') stdout += text; else stderr += text; }, read: () => ({stdout, stderr})};
}

// FORCE_INTERACTIVE: setup slurps every answer from stdin before the wizard
// starts, so the answer block is written once and stdin closed.
function runScripted({mode, repo, binDir, answers, timeoutMs = 20000}) {
  const proc = spawnSetup({mode, repo, binDir, forceInteractive: true, timeoutMs});
  proc.child.stdout.on('data', c => proc.chunk('out', c.toString('utf8')));
  proc.child.stderr.on('data', c => proc.chunk('err', c.toString('utf8')));
  try {
    proc.child.stdin.write(answers.map(a => `${a}\n`).join(''));
    proc.child.stdin.end();
  } catch { /* child already gone */ }
  return proc.done;
}

// Non-TTY: readline answers, one line only after a prompt tail has actually
// been printed, stdin left open (EOF here would make readline close and
// every later question throw/hang). A bare '' answers every prompt with its
// default, so any unexpected prompt is answered safely instead of hanging.
function runPiped({mode, repo, binDir, timeoutMs = 20000}) {
  const proc = spawnSetup({mode, repo, binDir, forceInteractive: false, timeoutMs});
  let lastAnsweredLen = 0;
  const maybeAnswer = () => {
    const {stdout} = proc.read();
    if (!PROMPT_TAIL.test(stdout.slice(-500))) return;
    if (stdout.length <= lastAnsweredLen) return;
    lastAnsweredLen = stdout.length;
    try { proc.child.stdin.write('\n'); } catch { /* closed */ }
  };
  proc.child.stdout.on('data', c => { proc.chunk('out', c.toString('utf8')); maybeAnswer(); });
  proc.child.stderr.on('data', c => proc.chunk('err', c.toString('utf8')));
  return proc.done;
}

function assertCleanRun(caseName, r) {
  const combined = `${r.stdout}\n${r.stderr}`;
  check(`${caseName}: setup completed`, r.status === 0 && !r.timedOut && !r.error,
    `status=${r.status} timedOut=${r.timedOut} signal=${r.signal} error=${r.error}\n${combined.slice(-1500)}`);
  return combined;
}

async function runCase(name, fn) {
  console.log(`\n${name}:`);
  const started = Date.now();
  const binDir = makeFakeCliDir(fn.fakes || ['claude']);
  const repos = [];
  try {
    await fn({binDir, makeRepo: () => { const r = makeRepo(); repos.push(r); return r; }, seed: config => { const r = seedRepo(config); repos.push(r); return r; }});
  } catch (error) {
    failed++;
    console.log(`  ✗ case threw: ${error?.stack || error}`);
  } finally {
    for (const repo of repos) {
      try { fs.rmSync(repo, {recursive: true, force: true}); } catch { /* best effort */ }
    }
    try { fs.rmSync(binDir, {recursive: true, force: true}); } catch { /* best effort */ }
    const elapsed = Date.now() - started;
    check(`${name}: under 20s`, elapsed < 20000, `${elapsed} ms`);
    console.log(`  (${elapsed} ms)`);
  }
}

const overallStarted = Date.now();

// Wizard answer prefix: continue + (adapter, fallback) x 5 + gates. A re-run
// over an existing config first answers the "already set up" yes/no. allNo
// alternates '' and '1' across the five fallback answers so both spellings
// of No are covered.
function wizardAnswers(fallbacks, existingConfig = false) {
  const out = existingConfig ? ['y'] : [];
  out.push('');
  for (const f of fallbacks) {
    out.push('1', ...f);
  }
  out.push('');
  return out;
}

// 1. Skip: '' and '1' both mean No; no role gains a fallbacks key.
await runCase('skip writes no fallbacks key', async ({binDir, makeRepo}) => {
  const repo = makeRepo();
  const r = await runScripted({mode: '--wizard', repo, binDir,
    answers: wizardAnswers([[''], ['1'], [''], ['1'], ['']])});
  const combined = assertCleanRun('skip', r);
  check('wizard asks the fallback question', FALLBACK_PROMPT.test(combined));
  check('prompt carries the reviewer mark', REVIEWER_HINT.test(combined));
  check('prompt carries the quota mark', QUOTA_HINT.test(combined));
  check('prompt carries the paid mark', PAID_HINT.test(combined));
  const saved = readConfig(repo);
  for (const role of ['planner', 'plan_reviewer', 'implementer', 'code_reviewer', 'verifier']) {
    check(`no fallbacks key on ${role}`, !('fallbacks' in (saved.roles[role] || {})),
      JSON.stringify(saved.roles[role]));
  }
});

// 2. Add two: new picks persist in order.
async function addTwoCase({binDir, makeRepo}) {
  const repo = makeRepo();
  // Planner: Yes, claude, add-another Yes, codex, add-another No(1).
  const r = await runScripted({mode: '--wizard', repo, binDir,
    answers: wizardAnswers([['2', '1', '2', '2', '1'], ['1'], ['1'], ['1'], ['1']])});
  const combined = assertCleanRun('add-two', r);
  check('add-another shows the current list', CURRENT_LIST.test(combined));
  const saved = readConfig(repo);
  checkEqual('two picks persist in order', saved.roles.planner?.fallbacks,
    [{cli: 'claude', model: ''}, {cli: 'codex', model: ''}]);
  for (const role of ['plan_reviewer', 'implementer', 'code_reviewer', 'verifier']) {
    check(`no fallbacks key on ${role}`, !('fallbacks' in (saved.roles[role] || {})));
  }
  return repo;
}
addTwoCase.fakes = ['claude', 'codex'];
await runCase('add-two-in-order', addTwoCase);

// 3. Wizard re-run append: prior entries stay first, in order.
async function rerunCase({binDir, makeRepo}) {
  const repo = makeRepo();
  const first = await runScripted({mode: '--wizard', repo, binDir,
    answers: wizardAnswers([['2', '1', '1'], ['1'], ['1'], ['1'], ['1']])});
  assertCleanRun('re-run first pass', first);
  checkEqual('first pass saves one fallback', readConfig(repo).roles.planner?.fallbacks,
    [{cli: 'claude', model: ''}]);
  // Second wizard run over the same repo: planner adds codex. The existing
  // config now needs the "run the full setup again?" yes first.
  const second = await runScripted({mode: '--wizard', repo, binDir,
    answers: wizardAnswers([['2', '2', '1'], ['1'], ['1'], ['1'], ['1']], true)});
  const combined = assertCleanRun('re-run second pass', second);
  check('re-run prompt shows the carried-forward list', CURRENT_LIST.test(combined),
    combined.slice(-2000));
  checkEqual('prior entries stay first in order', readConfig(repo).roles.planner?.fallbacks,
    [{cli: 'claude', model: ''}, {cli: 'codex', model: ''}]);
}
rerunCase.fakes = ['claude', 'codex'];
await runCase('wizard re-run append', rerunCase);

// 4. Reviewer warning: code_reviewer fallback matching the implementer
// primary warns but still saves.
await runCase('reviewer warning still saves', async ({binDir, makeRepo}) => {
  const repo = makeRepo();
  const r = await runScripted({mode: '--wizard', repo, binDir,
    answers: wizardAnswers([['1'], ['1'], ['1'], ['2', '1', '1'], ['1']])});
  const combined = assertCleanRun('reviewer warning', r);
  check('warning prints', REVIEWER_WARNING.test(combined),
    combined.slice(-2000));
  checkEqual('fallback still saved', readConfig(repo).roles.code_reviewer?.fallbacks,
    [{cli: 'claude', model: ''}]);
});

// 5. --edit asks nothing new: no fallback prompt, existing list survives.
await runCase('--edit keeps fallbacks without asking', async ({binDir, seed}) => {
  const prior = [{cli: 'claude', model: ''}];
  const repo = seed(baseConfig({fallbacks: {planner: prior}}));
  // Scope "All configuration" (the framework is auto-picked), then the
  // default CLI and "Keep current fallbacks" for each of the five roles.
  const r = await runScripted({mode: '--edit', repo, binDir,
    answers: ['1', ...Array(10).fill(''), '']});
  const combined = assertCleanRun('--edit', r);
  check('no fallback prompt under --edit', !FALLBACK_PROMPT.test(combined),
    combined.slice(-2000));
  checkEqual('existing fallbacks survive', readConfig(repo).roles.planner?.fallbacks, prior);
});

// 6. Non-TTY wizard run is unblocked and writes no fallbacks key.
await runCase('non-TTY run is unblocked', async ({binDir, makeRepo}) => {
  const repo = makeRepo();
  const r = await runPiped({mode: '--wizard', repo, binDir, timeoutMs: 25000});
  const combined = assertCleanRun('non-TTY', r);
  check('no hang waiting on a fallback answer', !r.timedOut);
  const saved = readConfig(repo);
  for (const role of ['planner', 'plan_reviewer', 'implementer', 'code_reviewer', 'verifier']) {
    check(`no fallbacks key on ${role}`, !('fallbacks' in (saved.roles[role] || {})));
  }
  void combined;
});

const totalElapsed = Date.now() - overallStarted;
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${totalElapsed} ms total)`);
console.log('='.repeat(50));
if (totalElapsed >= 120000) {
  console.log(`✗ whole file took ${totalElapsed} ms (budget: 120000 ms)`);
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
