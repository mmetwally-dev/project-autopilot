#!/usr/bin/env node
// Hermetic end-to-end for the single escalation-model question of
// `ap config` (backlog #4): ONE question for planner + implementer, asked
// right after the last role's (verifier) questions and before "Planning
// framework"; a single-role edit asks about that role only. setup.mjs runs
// as a subprocess through a hermetic PATH with a fake claude CLI and
// AUTOPILOT_SETUP_FORCE_INTERACTIVE=1 (positional stdin answers).

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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-escalation-q-fake-cli-'));
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
  // Fake opencode with a live model list so the escalation model can be picked.
  const server = path.join(binDir, 'fake-opencode.mjs');
  fs.writeFileSync(server, [
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
    'if (a[0] === "--help") { process.stdout.write("Usage: opencode\\n  -m, --model <name>\\n"); process.exit(0); }',
    'if (a[0] === "models" && a[1] === "--verbose") { process.exit(1); }',
    'if (a[0] === "models") { process.stdout.write("opencode/mimo-v2.6-flash-free\\nopencode/glm-5.3-flash-free\\n"); process.exit(0); }',
    'process.exit(0);'
  ].join('\n'));
  const binary = path.join(binDir, 'opencode');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
  fs.chmodSync(binary, 0o755);
  return binDir;
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-escalation-q-flow-'));
}

function baseConfig({escalation} = {}) {
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
  if (escalation) {
    for (const [role, model] of Object.entries(escalation)) {
      roles[role].escalation_model = model;
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


const ESC_Q_OFF = /Use a stronger model for the planner and implementer when they get stuck/;
const ESC_Q_SAVED = /Stronger model for the planner and implementer when stuck:/;
const ESC_ANY = /stronger model/i;
const ESC_PICK = {cli: 'opencode', model: 'opencode/mimo-v2.6-flash-free'};

const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;

// --edit "All configuration": scope, (adapter, edit-menu) x 5, then `after`
// answers (escalation question etc.), then gates. The single framework choice
// (standalone here) is selected without a question.
const allAnswers = after => ['1', ...['1', '1', '1', '1', '1', '1', '1', '1', '1', '1'], ...after, ''];
// --edit "One role": scope 2, role number, adapter, edit-menu, `after`.
const roleAnswers = (roleNo, after) => ['2', String(roleNo), '1', '1', ...after];

function ok(name, r) {
  const combined = `${r.stdout}\n${r.stderr}`;
  check(`${name}: setup completed`, r.status === 0 && !r.timedOut && !r.error,
    `status=${r.status}\n${combined.slice(-1500)}`);
  return combined;
}

await runCase('Yes sets the same model on planner and implementer; one question; right order', async ({binDir, seed}) => {
  const repo = seed(baseConfig());
  // Escalation: '2' = Yes, then CLI '1' (claude).
  const r = await runScripted({mode: '--edit', repo, binDir, answers: allAnswers(['2', '2', '2'])});
  const out = ok('yes', r);
  check('(a) exactly one escalation question', count(out, /Use a stronger model for/) === 1 && !/Stronger model to use for one round/.test(out), out.slice(-1500));
  check('question shows the not-fixed count', /not fixed twice\)/.test(out));
  const cfg = readConfig(repo);
  checkEqual('(b) planner escalation_model', cfg.roles.planner.escalation_model, ESC_PICK);
  check('(b) planner model is set', !!cfg.roles.planner.escalation_model);
  checkEqual('(b) implementer identical', cfg.roles.implementer.escalation_model, cfg.roles.planner.escalation_model);
  check('other roles untouched', !cfg.roles.code_reviewer.escalation_model && !cfg.roles.verifier.escalation_model);
  check('summary line printed', /escalation model \(planner \+ implementer\): /.test(out));
  const q = out.search(ESC_Q_OFF);
  const lastRole = out.lastIndexOf('Verifier CLI');
  const gates = out.indexOf('Test command (Autopilot runs it after each phase');
  check('(e) after the verifier questions', q > 0 && lastRole >= 0 && lastRole < q, `q=${q} verifier=${lastRole}`);
  check('(e) before the gate/runtime/network questions that follow', gates > q, `q=${q} gates=${gates}`);
  check('(e) the single framework choice is announced before the role questions', out.indexOf('✓ Planning: Standalone') >= 0 && out.indexOf('✓ Planning: Standalone') < out.indexOf('Planner CLI'));
});

await runCase('Turn off clears both', async ({binDir, seed}) => {
  const repo = seed(baseConfig({escalation: {planner: ESC_PICK, implementer: ESC_PICK}}));
  // saved: Keep(1) / Choose(2) / Turn off(3)
  const r = await runScripted({mode: '--edit', repo, binDir, answers: allAnswers(['3'])});
  const out = ok('off', r);
  check('saved-value question shown', ESC_Q_SAVED.test(out), out.slice(-1500));
  const cfg = readConfig(repo);
  check('(c) planner cleared', !('escalation_model' in cfg.roles.planner));
  check('(c) implementer cleared', !('escalation_model' in cfg.roles.implementer));
});

await runCase('Keep leaves values unchanged', async ({binDir, seed}) => {
  const repo = seed(baseConfig({escalation: {planner: ESC_PICK}}));
  const r = await runScripted({mode: '--edit', repo, binDir, answers: allAnswers(['1'])});
  ok('keep', r);
  const cfg = readConfig(repo);
  checkEqual('planner kept', cfg.roles.planner.escalation_model, ESC_PICK);
  check('implementer still off', !('escalation_model' in cfg.roles.implementer));
});

await runCase('No (off) saves nothing', async ({binDir, seed}) => {
  const repo = seed(baseConfig());
  const r = await runScripted({mode: '--edit', repo, binDir, answers: allAnswers(['1'])});
  ok('no', r);
  const cfg = readConfig(repo);
  check('neither role has a model', !('escalation_model' in cfg.roles.planner) && !('escalation_model' in cfg.roles.implementer));
});

await runCase('(d) single-role edit only asks about and changes that role', async ({binDir, seed}) => {
  const repo = seed(baseConfig({escalation: {planner: ESC_PICK}}));
  // implementer is role 3; no saved value for it: '2' = Yes, '1' = claude.
  const r = await runScripted({mode: '--edit', repo, binDir, answers: roleAnswers(3, ['2', '2', '2'])});
  const out = ok('single', r);
  check('question is about the implementer only', /Use a stronger model for the implementer when it gets stuck/.test(out) && !/planner and implementer/.test(out), out.slice(-1500));
  check('one question', count(out, ESC_ANY) === 1, String(count(out, ESC_ANY)));
  const cfg = readConfig(repo);
  checkEqual('implementer set', cfg.roles.implementer.escalation_model, ESC_PICK);
  checkEqual('planner untouched', cfg.roles.planner.escalation_model, ESC_PICK);
  check('summary names the role', /escalation model \(implementer\): /.test(out));
});

await runCase('non-escalation role edit asks nothing', async ({binDir, seed}) => {
  const repo = seed(baseConfig());
  const r = await runScripted({mode: '--edit', repo, binDir, answers: roleAnswers(5, [])});
  const out = ok('verifier', r);
  check('no escalation question', !ESC_ANY.test(out));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
