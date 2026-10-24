#!/usr/bin/env node
// Hermetic end-to-end for `ap config` (--edit) per-role fallback editing
// (backlog #88, phase 3.1): edit mode shows the role's current fallbacks and
// offers Keep/Add/Remove/Reorder with Keep as option 1 and the default.
//
// setup.mjs runs as a subprocess through a hermetic PATH holding fake CLIs
// (the copy-of-`true` ELF pattern from test-setup-first-run-e2e.mjs), so no
// real agent CLI and no network is ever touched.
//
// Interactive cases run with AUTOPILOT_SETUP_FORCE_INTERACTIVE=1, which makes
// setup read its whole answer block from stdin up front (no readline
// involved) and answer positionally. With only fake `claude` installed,
// capabilities report model=no/effort=no/variant=no, so each role consumes
// exactly two answers (adapter choose, fallback edit-menu choose) plus one
// answer per extra edit prompt (fallback adapter choose for Add, entry
// choose for Remove, entry + position chooses for Reorder); the --edit run
// is: scope, planning framework, (adapter, edit-menu, ...) x 5, gates
// command. The non-TTY case must NOT set that variable: setup then talks to
// a piped stdin through readline, answers are written only in response to
// newly observed prompt output and stdin is never closed, so a prompt that
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
const setupSource = fs.readFileSync(setupScript, 'utf8');

const EDIT_MENU = /Edit fallbacks for /;
const KEEP_OPTION = /Keep current fallbacks/;
const CURRENT_LIST = /Current fallbacks:/;
const FALLBACK_CLI_PROMPT = /fallback CLI/;
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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fallbacks-edit-fake-cli-'));
  for (const name of names) {
    const fake = path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
    if (process.platform === 'win32') {
      fs.writeFileSync(fake, '@echo off\nif "%1"=="--version" (echo fake-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
    } else {
      const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
      fs.copyFileSync(realTrue, fake);
      fs.chmodSync(fake, 0o755);
    }
  }
  return binDir;
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fallbacks-edit-flow-'));
}

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

// --edit answer prefix: scope, (adapter, edit-menu) x 5, gates.
// `menus` holds the five per-role edit-menu answers; `extra` maps a role
// index (0-4) to the follow-up answers its edit choice consumes.
function editAnswers(menus, extra = {}) {
  const out = ['1'];
  const roles = [0, 1, 2, 3, 4];
  for (const i of roles) {
    out.push('1', menus[i] ?? '1');
    if (extra[i]) out.push(...extra[i]);
  }
  out.push('');
  return out;
}

const overallStarted = Date.now();

// 1. Show: edit mode prints the role's current fallbacks; Keep leaves them.
await runCase('show keeps current fallbacks', async ({binDir, seed}) => {
  const prior = [{cli: 'claude', model: ''}];
  const repo = seed(baseConfig({fallbacks: {planner: prior}}));
  // Alternate '' and '1' across the five menus so both spellings of Keep
  // are covered.
  const r = await runScripted({mode: '--edit', repo, binDir,
    answers: editAnswers(['', '1', '', '1', ''])});
  const combined = assertCleanRun('show', r);
  check('edit menu is offered', EDIT_MENU.test(combined), combined.slice(-2000));
  check('Keep is the first option', KEEP_OPTION.test(combined));
  check('current fallbacks are shown', CURRENT_LIST.test(combined) && /claude/.test(combined),
    combined.slice(-2000));
  check('Keep asks no further fallback question', !FALLBACK_CLI_PROMPT.test(combined),
    combined.slice(-2000));
  checkEqual('kept list unchanged', readConfig(repo).roles.planner?.fallbacks, prior);
});

// 2. Add: a new pick is appended after the existing entries, in order.
async function addCase({binDir, seed}) {
  const repo = seed(baseConfig({fallbacks: {planner: [{cli: 'claude', model: ''}]}}));
  // Planner: Keep-menu answer '2' (Add), fallback adapter '2' (codex).
  const r = await runScripted({mode: '--edit', repo, binDir,
    answers: editAnswers(['2', '1', '1', '1', '1'], {0: ['2']})});
  const combined = assertCleanRun('add', r);
  check('add shows the carried-forward list', CURRENT_LIST.test(combined), combined.slice(-2000));
  checkEqual('added fallback saved after existing ones in order',
    readConfig(repo).roles.planner?.fallbacks,
    [{cli: 'claude', model: ''}, {cli: 'codex', model: ''}]);
}
addCase.fakes = ['claude', 'codex'];
await runCase('add appends in order', addCase);

// 3. Remove: dropping one entry persists; emptying removes the key.
async function removeCase({binDir, seed}) {
  const repo = seed(baseConfig({fallbacks: {
    planner: [{cli: 'claude', model: ''}, {cli: 'codex', model: ''}],
    implementer: [{cli: 'claude', model: ''}]
  }}));
  // Planner removes entry 1 (claude); implementer removes its only entry.
  const r = await runScripted({mode: '--edit', repo, binDir,
    answers: editAnswers(['3', '1', '3', '1', '1'], {0: ['1'], 2: ['1']})});
  assertCleanRun('remove', r);
  checkEqual('remove persists the remainder',
    readConfig(repo).roles.planner?.fallbacks,
    [{cli: 'codex', model: ''}]);
  check('emptying removes the fallbacks key',
    !('fallbacks' in (readConfig(repo).roles.implementer || {})),
    JSON.stringify(readConfig(repo).roles.implementer));
}
removeCase.fakes = ['claude', 'codex'];
await runCase('remove persists and emptying removes key', removeCase);

// 4. Reorder: moving the second entry first persists.
async function reorderCase({binDir, seed}) {
  const repo = seed(baseConfig({fallbacks: {
    planner: [{cli: 'claude', model: ''}, {cli: 'codex', model: ''}]
  }}));
  // Planner: Reorder ('4'), move entry 2 (codex), to Position 1.
  const r = await runScripted({mode: '--edit', repo, binDir,
    answers: editAnswers(['4', '1', '1', '1', '1'], {0: ['2', '1']})});
  assertCleanRun('reorder', r);
  checkEqual('reorder persists',
    readConfig(repo).roles.planner?.fallbacks,
    [{cli: 'codex', model: ''}, {cli: 'claude', model: ''}]);
}
reorderCase.fakes = ['claude', 'codex'];
await runCase('reorder persists', reorderCase);

// 4b. Summary: `ap config` lists each role's fallbacks under its role line.
await runCase('summary lists fallbacks', async ({binDir, seed}) => {
  const repo = seed(baseConfig({fallbacks: {planner: [
    {cli: 'opencode', model: 'opencode/a-free', reasoning: 'medium', variant: ''},
    {cli: 'claude', model: 'haiku', reasoning: '', variant: 'v1'}
  ]}}));
  const r = await runScripted({mode: '--edit', repo, binDir, answers: editAnswers([])});
  const combined = assertCleanRun('summary', r);
  const lines = combined.split('\n');
  const at = lines.findIndex(l => l.startsWith('✓ planner:'));
  check('planner line printed', at >= 0, combined.slice(0, 1500));
  checkEqual('fallback 1 line', lines[at + 1], '    fallback 1: opencode / opencode/a-free / effort=medium');
  checkEqual('fallback 2 line', lines[at + 2], '    fallback 2: claude / haiku / effort=default / variant=v1');
  const next = lines.findIndex(l => l.startsWith('✓ plan_reviewer:'));
  checkEqual('role without fallbacks has no extra line', next, at + 3);
  check('only two fallback lines in summary', lines.filter(l => /^ {4}fallback \d+:/.test(l)).length === 2);
});

// 5. Non-TTY run leaves fallbacks untouched with no hang.
await runCase('non-TTY leaves fallbacks untouched', async ({binDir, seed}) => {
  const prior = [{cli: 'claude', model: ''}];
  const repo = seed(baseConfig({fallbacks: {planner: prior}}));
  const r = await runPiped({mode: '--edit', repo, binDir, timeoutMs: 25000});
  assertCleanRun('non-TTY', r);
  check('no hang on the edit menu', !r.timedOut);
  checkEqual('fallbacks untouched', readConfig(repo).roles.planner?.fallbacks, prior);
});

// 6. Source hygiene: no CLI-availability log line near the fallback edit
// region (the UX source-window test covers the editMode scope-selector
// window; the fallback edit must not add one anywhere either).
{
  console.log('\nsource hygiene:');
  const matches = setupSource.match(/CLI availability:/g) || [];
  check('single CLI-availability line (wizard only)', matches.length === 1,
    `found ${matches.length}`);
}

// 7. Docs presence: README.md and SKILL.md each carry one short fallbacks
// paragraph covering all four points (rate-limit/quota-only trigger, sticky
// per mission, set via ap setup/ap config, reviewer-independence warning).
{
  console.log('\ndocs presence:');
  const docs = ['README.md', 'SKILL.md'].map(f => ({
    name: f,
    text: fs.readFileSync(path.join(root, f), 'utf8').toLowerCase()
  }));
  for (const {name, text} of docs) {
    check(`${name}: rate-limit/quota-only trigger`, /rate-limit/.test(text) && /quota/.test(text));
    check(`${name}: sticky per mission`, /sticky/.test(text) && /mission/.test(text));
    check(`${name}: set via ap setup/ap config`, text.includes('ap setup') && text.includes('ap config'));
    check(`${name}: reviewer-independence warning`, /reviewer/.test(text) && /independent/.test(text));
  }
}

const totalElapsed = Date.now() - overallStarted;
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${totalElapsed} ms total)`);
console.log('='.repeat(50));
if (totalElapsed >= 120000) {
  console.log(`✗ whole file took ${totalElapsed} ms (budget: 120000 ms)`);
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
