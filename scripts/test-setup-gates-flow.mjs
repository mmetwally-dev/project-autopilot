#!/usr/bin/env node
// Hermetic end-to-end for setup's gates.commands proposal (backlog #37).
//
// setup.mjs runs as a subprocess through a hermetic PATH holding a fake
// `claude` (the copy-of-`true` ELF pattern from test-setup-first-run-e2e.mjs),
// so no real agent CLI and no network is ever touched. Each case pre-creates a
// minimal valid .autopilot/config.json and runs `setup --edit`, answering
// "Framework / safety" — the narrowest scope that reaches the gates question —
// so only three prompts are answered per run.
//
// Interactive cases run with AUTOPILOT_SETUP_FORCE_INTERACTIVE=1, which makes
// setup read its whole answer block from stdin up front (no readline involved)
// and answer positionally: scope, planning framework, gates question.
// The non-TTY case must NOT set that variable: setup then talks to a piped
// stdin through readline, answers are written only in response to newly
// observed prompt output (same driver as test-setup-runtime-mode-selection.mjs)
// and stdin is never closed, so a prompt that should not exist would hang the
// run into the watchdog instead of being silently answered.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');

const WARNING =
  'Warning: gate runs with network isolation; tests requiring network access must be excluded or mocked';
const HAND_EDIT_HINT =
  'edit .autopilot/config.json "gates": {"commands": ["<full command>"]}';
const GATES_PROMPT = /Gate test command/;
const DETECTED_PROMPT = /Gate test command \[npm test\]/;
const NONE_DETECTED = /No test command detected for this project\./;
const PROMPT_TAIL = /: $|Press Enter[^\n]*\s$/;

// "3" = Framework / safety, then the (only) planning framework choice.
const SCOPE_RULE = {pattern: /Configuration scope:/, answer: '3'};
const FRAMEWORK_RULE = {pattern: /\nPlanning framework\n/, answer: '1'};

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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-gates-fake-cli-'));
  const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeClaude, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
  } else {
    // A plain shebang script named `claude` is rejected by adapter-drivers.mjs
    // as an npm-style Windows launcher shim, so the fake CLI is a copy of a
    // real ELF (`true`): classified `native`, admitted, exit status 0.
    const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return binDir;
}

function makeRepo({commands, detected = true} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-gates-flow-'));
  const configDir = path.join(repo, '.autopilot');
  fs.mkdirSync(configDir, {recursive: true});
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(baseConfig(commands), null, 2) + '\n');
  if (detected) {
    fs.writeFileSync(path.join(repo, 'package.json'),
      JSON.stringify({name: 'gates-flow-fixture', scripts: {test: 'node run-tests.mjs'}}, null, 2) + '\n');
  }
  return repo;
}

// Minimal but complete and validation-clean config: roles already point at the
// fake `claude` with no model selection (so validation cannot raise an
// unverified-model confirmation), and no execution block (setup auto-selects
// the single available strong runtime mode without asking).
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
    project: {
      repo: '.',
      planning_framework: 'standalone',
      state_file: '.autopilot/state.json',
      runs_dir: '.autopilot/runs'
    },
    roles: {
      planner: one(),
      plan_reviewer: one(),
      implementer: one(),
      code_reviewer: one(),
      verifier: one()
    },
    workflow: {},
    gates,
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

function readConfig(repo) {
  const file = path.join(repo, '.autopilot', 'config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readGateCommands(repo) {
  const config = readConfig(repo);
  // v4 layout: tests.gate_commands (legacy: gates.commands)
  return config.tests?.gate_commands ?? config.gates?.commands;
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
  return {child, done, chunk: (stream, text) => { if (stream === 'out') stdout += text; else stderr += text; }, read: () => ({stdout, stderr})};
}

// FORCE_INTERACTIVE: setup slurps every answer from stdin before the wizard
// starts, so the answer block is written once and stdin closed.
function runScripted({repo, binDir, answers, timeoutMs = 15000}) {
  const proc = spawnSetup({repo, binDir, forceInteractive: true, timeoutMs});
  proc.child.stdout.on('data', c => proc.chunk('out', c.toString('utf8')));
  proc.child.stderr.on('data', c => proc.chunk('err', c.toString('utf8')));
  try {
    proc.child.stdin.write(answers.map(a => `${a}\n`).join(''));
    proc.child.stdin.end();
  } catch { /* child already gone */ }
  return proc.done;
}

// Non-TTY: readline answers, one line only after the matching prompt has
// actually been printed, stdin left open (EOF here would make readline close
// and every later question throw/hang).
function runPiped({repo, binDir, rules, timeoutMs = 15000}) {
  const proc = spawnSetup({repo, binDir, forceInteractive: false, timeoutMs});
  const fired = new Set();
  let lastAnsweredLen = 0;
  const writeLine = line => {
    try { proc.child.stdin.write(`${line}\n`); } catch { /* closed */ }
  };
  const maybeAnswer = () => {
    const {stdout} = proc.read();
    if (!PROMPT_TAIL.test(stdout.slice(-500))) return;
    if (stdout.length <= lastAnsweredLen) return;
    for (let i = 0; i < rules.length; i++) {
      if (fired.has(i)) continue;
      if (rules[i].pattern.test(stdout)) {
        fired.add(i);
        lastAnsweredLen = stdout.length;
        writeLine(rules[i].answer);
        return;
      }
    }
    lastAnsweredLen = stdout.length;
    writeLine('');
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
  const binDir = makeFakeCliDir();
  const repos = [];
  try {
    await fn({binDir, makeRepo: opts => { const r = makeRepo(opts); repos.push(r); return r; }});
  } catch (error) {
    failed++;
    console.log(`  ✗ case threw: ${error?.stack || error}`);
  } finally {
    for (const repo of repos) {
      try { fs.rmSync(repo, {recursive: true, force: true}); } catch { /* best effort */ }
    }
    try { fs.rmSync(binDir, {recursive: true, force: true}); } catch { /* best effort */ }
    const elapsed = Date.now() - started;
    check(`${name}: under 10s`, elapsed < 10000, `${elapsed} ms`);
    console.log(`  (${elapsed} ms)`);
  }
}

const overallStarted = Date.now();

// 1. Detected command + Enter → the proposal is stored as one command.
await runCase('detected + Enter', async ({binDir, makeRepo}) => {
  const repo = makeRepo({});
  const r = await runScripted({repo, binDir, answers: ['3', '1', '']});
  const combined = assertCleanRun('detected + Enter', r);
  check('prompts for the detected command', DETECTED_PROMPT.test(combined),
    `prompt missing from output:\n${combined.slice(-2000)}`);
  checkEqual('stores ["npm test"]', readGateCommands(repo), ['npm test']);
});

// 2. Detected command + typed edit → the typed string is stored verbatim, as
//    ONE shell string (never split into words).
await runCase('detected + typed edit', async ({binDir, makeRepo}) => {
  const repo = makeRepo({});
  const r = await runScripted({repo, binDir, answers: ['3', '1', 'npm run test:ci -- --ci']});
  const combined = assertCleanRun('detected + typed edit', r);
  check('prompts for the detected command', DETECTED_PROMPT.test(combined));
  const commands = readGateCommands(repo);
  checkEqual('stores the edited command as one string', commands, ['npm run test:ci -- --ci']);
});

// 3. "-" → keep [].
await runCase('"-" keeps empty', async ({binDir, makeRepo}) => {
  const repo = makeRepo({});
  const r = await runScripted({repo, binDir, answers: ['3', '1', '-']});
  const combined = assertCleanRun('"-" keeps empty', r);
  check('still asked', DETECTED_PROMPT.test(combined));
  checkEqual('keeps []', readGateCommands(repo), []);
  check('no network-isolation warning for an empty gate', !combined.includes(WARNING));
});

// 4. Existing non-empty value: kept, and setup must not ask again.
await runCase('existing non-empty kept without asking', async ({binDir, makeRepo}) => {
  const existing = ['node scripts/test-all.mjs --skip-live'];
  const repo = makeRepo({commands: existing});
  const r = await runScripted({repo, binDir, answers: ['3', '1', '']});
  const combined = assertCleanRun('existing non-empty kept', r);
  check('does not print the gates prompt', !GATES_PROMPT.test(combined),
    `unexpected prompt:\n${combined.slice(-2000)}`);
  checkEqual('keeps the existing value', readGateCommands(repo), existing);
  check('no warning for a value that did not change', !combined.includes(WARNING));
});

// 5. Existing [] → detect + ask (the spread-order bug made this impossible).
await runCase('existing [] is asked', async ({binDir, makeRepo}) => {
  const repo = makeRepo({commands: []});
  const r = await runScripted({repo, binDir, answers: ['3', '1', '']});
  const combined = assertCleanRun('existing [] is asked', r);
  check('prompts for the detected command', DETECTED_PROMPT.test(combined),
    `prompt missing from output:\n${combined.slice(-2000)}`);
  checkEqual('stores the confirmed command', readGateCommands(repo), ['npm test']);
});

// 6. Nothing detected → still asked; typed command stored; "" or "-" keeps [].
await runCase('nothing detected + typed command', async ({binDir, makeRepo}) => {
  const repo = makeRepo({detected: false});
  const r = await runScripted({repo, binDir, answers: ['3', '1', 'pytest -q -k unit']});
  const combined = assertCleanRun('nothing detected', r);
  check('reports that nothing was detected', NONE_DETECTED.test(combined),
    `missing from output:\n${combined.slice(-2000)}`);
  check('asks anyway', GATES_PROMPT.test(combined));
  checkEqual('stores the typed command as one string', readGateCommands(repo), ['pytest -q -k unit']);
});

// 7. Commands becoming non-empty print the network-isolation warning exactly once.
await runCase('warning printed once', async ({binDir, makeRepo}) => {
  const repo = makeRepo({});
  const r = await runScripted({repo, binDir, answers: ['3', '1', '']});
  const combined = assertCleanRun('warning printed once', r);
  const occurrences = combined.split(WARNING).length - 1;
  checkEqual('warning printed exactly once', occurrences, 1);
});

// 8. Non-TTY stdin: no prompt, no hang, [] kept, hand-edit hint printed.
await runCase('non-TTY keeps [] and prints the hint', async ({binDir, makeRepo}) => {
  const repo = makeRepo({});
  const r = await runPiped({repo, binDir, rules: [SCOPE_RULE, FRAMEWORK_RULE], timeoutMs: 15000});
  const combined = assertCleanRun('non-TTY', r);
  check('does not print the gates prompt', !GATES_PROMPT.test(combined),
    `setup prompted on a non-TTY stdin:\n${combined.slice(-2000)}`);
  check('prints the hand-edit hint', combined.includes(HAND_EDIT_HINT),
    `hint missing from output:\n${combined.slice(-2000)}`);
  checkEqual('keeps []', readGateCommands(repo), []);
});

// 9. Non-TTY stdin with an existing value: kept, still no prompt, hint printed.
await runCase('non-TTY keeps an existing value', async ({binDir, makeRepo}) => {
  const existing = ['npm test --workspace=unit'];
  const repo = makeRepo({commands: existing});
  const r = await runPiped({repo, binDir, rules: [SCOPE_RULE, FRAMEWORK_RULE], timeoutMs: 15000});
  const combined = assertCleanRun('non-TTY existing', r);
  check('does not print the gates prompt', !GATES_PROMPT.test(combined),
    `setup prompted on a non-TTY stdin:\n${combined.slice(-2000)}`);
  check('prints the hand-edit hint', combined.includes(HAND_EDIT_HINT),
    `hint missing from output:\n${combined.slice(-2000)}`);
  checkEqual('keeps the existing value', readGateCommands(repo), existing);
});

const totalElapsed = Date.now() - overallStarted;
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${totalElapsed} ms total)`);
console.log('='.repeat(50));
if (totalElapsed >= 60000) {
  console.log(`✗ whole file took ${totalElapsed} ms (budget: 60000 ms)`);
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
