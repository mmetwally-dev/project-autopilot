#!/usr/bin/env node
// Backlog #4, #5 and #6 — setup/config polish:
//   #4  one planning-framework option is selected without a question;
//   #5  live model catalogs longer than 15 models get the short menu
//       (free models, search by name, show all) and the saved id is unchanged;
//   #6  `ap setup` on an already configured project asks before restarting.
// Hermetic subprocess tests with fake CLIs and temp repos only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const count = (text, needle) => String(text).split(needle).length - 1;

const delimiter = process.platform === 'win32' ? ';' : ':';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemDirs = process.platform === 'win32'
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ['/usr/bin', '/bin'];

const LONG_MODELS = [
  'opencode/opus-4.6',
  'opencode/opus-4.5',
  'opencode/opus-mini',
  'opencode/gpt-5',
  'opencode/gpt-5-mini',
  'opencode/deepseek-v4',
  'opencode/alpha-model',
  'opencode/zeta-model',
  'opencode/glm-5-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/opus-free',
  'opencode/sonnet-free',
  'opencode/qwen-free',
  'opencode/kimi-free',
  'opencode/gemini-free',
  'opencode/llama-free',
  'opencode/mistral-free',
  'opencode/grok-free',
  'opencode/phi-free',
  'opencode/codestral-free'
];

const SHORT_MODELS = [
  'opencode/short-one',
  'opencode/short-two',
  'opencode/short-three',
  'opencode/short-four',
  'opencode/short-five',
  'opencode/short-six',
  'opencode/short-seven',
  'opencode/short-eight',
  'opencode/short-nine',
  'opencode/short-free',
  'opencode/short-free-two'
];

function makeFakeCliDir({models = LONG_MODELS, claude = false, opencode = true} = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-backlog-456-cli-'));
  if (claude) {
    const fake = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (process.platform === 'win32') {
      fs.writeFileSync(fake, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
    } else {
      const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
      fs.copyFileSync(realTrue, fake);
      fs.chmodSync(fake, 0o755);
    }
  }

  if (!opencode) return binDir;

  const server = path.join(binDir, 'fake-opencode.mjs');
  fs.writeFileSync(server, [
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
    'if (a[0] === "--help") { process.stdout.write("Usage: opencode\\n  -m, --model <name>\\n"); process.exit(0); }',
    'if (a[0] === "models" && a[1] === "--verbose") { process.exit(1); }',
    `if (a[0] === "models") { process.stdout.write(${JSON.stringify(models.join('\n') + '\n')}); process.exit(0); }`,
    'process.exit(0);'
  ].join('\n'));
  const binary = path.join(binDir, 'opencode');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
  fs.chmodSync(binary, 0o755);
  return binDir;
}

function makeRepo({speckit = false} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-backlog-456-repo-'));
  if (speckit) {
    const dir = path.join(repo, '.specify', 'workflows', 'speckit');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'workflow.yml'), 'steps: []\n');
  }
  return repo;
}

function roleTemplate(cli = 'claude', model = '') {
  return {
    cli,
    model,
    reasoning: '',
    variant: '',
    resume_session: true,
    model_source: model ? 'live' : 'default',
    model_verified_at: null,
    capabilities_verified_at: null
  };
}

function baseConfig({plannerCli = 'claude', plannerModel = ''} = {}) {
  return {
    schema_version: '4.0',
    project: {
      repo: '.',
      planning_framework: 'standalone',
      state_file: '.autopilot/state.json',
      runs_dir: '.autopilot/runs'
    },
    roles: {
      planner: roleTemplate(plannerCli, plannerModel),
      plan_reviewer: roleTemplate(),
      implementer: roleTemplate(),
      code_reviewer: roleTemplate(),
      verifier: roleTemplate()
    },
    workflow: {},
    gates: {env_allowlist: [], require_reviewer: true, network_isolation: true, commands: ['npm test']},
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
  const dir = path.join(repo, '.autopilot');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return repo;
}

function readConfig(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.autopilot', 'config.json'), 'utf8'));
}

function runSetup({mode, repo, binDir, answers, extraArgs = [], timeoutMs = 20000}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupScript, mode, ...extraArgs, '--repo', repo],
      {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => {
      clearTimeout(watchdog);
      resolve({status, stdout, stderr, combined: `${stdout}\n${stderr}`});
    });
    child.stdin.end(answers.map(a => `${a}\n`).join(''));
  });
}

const repos = [];
const binDirs = [];
function ownedRepo(options) {
  const repo = makeRepo(options);
  repos.push(repo);
  return repo;
}
function ownedSeed(config) {
  const repo = seedRepo(config);
  repos.push(repo);
  return repo;
}
function ownedCli(options) {
  const dir = makeFakeCliDir(options);
  binDirs.push(dir);
  return dir;
}

try {
  const searchBlock = (text, query, total) => {
    const start = text.indexOf(`Models matching "${query}":`);
    if (start < 0) return '';
    const endMarker = `Show all ${total} models`;
    const end = text.indexOf(endMarker, start);
    return end < 0 ? text.slice(start) : text.slice(start, end + endMarker.length);
  };

  const shortIndex = models => ({
    freeCount: models.filter(id => id.endsWith('-free')).length,
    search: 1 + models.filter(id => id.endsWith('-free')).length + 1,
    showAll: 1 + models.filter(id => id.endsWith('-free')).length + 2
  });

  // ── #4: one framework option is selected without a question ──────────
  {
    console.log('\n#4 single planning option:');
    const repo = ownedRepo();
    const binDir = ownedCli({claude: true, opencode: false});
    const r = await runSetup({mode: '--wizard', repo, binDir, answers: Array(20).fill('')});
    check('wizard exits 0', r.status === 0, r.combined.slice(-2000));
    check('prints the one-line planning result',
      r.combined.includes('✓ Planning: Standalone — PLAN.md + TASKS.md per mission in .autopilot/missions/<mission>/'),
      r.combined.slice(-2000));
    check('does not ask "Planning framework"', !r.combined.includes('Planning framework'));
  }

  {
    console.log('\n#4 two planning options:');
    const repo = ownedRepo({speckit: true});
    const binDir = ownedCli({claude: true, opencode: false});
    const answers = ['', ...Array(10).fill(''), '1', '2', ''];
    const r = await runSetup({mode: '--wizard', repo, binDir, answers});
    check('wizard exits 0', r.status === 0, r.combined.slice(-2000));
    check('still asks "Planning framework"', r.combined.includes('Planning framework'), r.combined.slice(-2000));
    checkEqual('saved framework follows the answer', readConfig(repo).project.planning_framework, 'standalone');
  }

  // ── #5: long model list ──────────────────────────────────────────────
  {
    console.log('\n#5 long list: short menu, free pick:');
    const repo = ownedSeed(baseConfig({plannerCli: 'opencode'}));
    const binDir = ownedCli();
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['2', '1', '1', '2', '1']});
    check('setup exits 0', r.status === 0, r.combined.slice(-2500));
    check('short menu appears exactly once',
      count(r.combined, `Planner model (live discovery from opencode, ${LONG_MODELS.length} models)`) === 1,
      r.combined.slice(-2500));
    check('search option appears exactly once',
      count(r.combined, 'Search by name (type part of it, e.g. "opus", "gpt-5", "deepseek")') === 1,
      r.combined.slice(-2500));
    check('show-all option names the total',
      r.combined.includes(`Show all ${LONG_MODELS.length} models`), r.combined.slice(-2500));
    check('the full 20-item list is not printed up front',
      !r.combined.includes('opencode/alpha-model'), r.combined.slice(-2500));
    checkEqual('picking the first free model saves its exact live id',
      readConfig(repo).roles.planner.model, 'opencode/glm-5-free');
  }

  {
    console.log('\n#5 long list: search option lists only matches:');
    const repo = ownedSeed(baseConfig({plannerCli: 'opencode'}));
    const binDir = ownedCli();
    const idx = shortIndex(LONG_MODELS);
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['2', '1', '1', String(idx.search), 'opus', '1', '1', '']});
    check('setup exits 0', r.status === 0, r.combined.slice(-2500));
    const block = searchBlock(r.combined, 'opus', LONG_MODELS.length);
    check('shows a search result block', block.length > 0, r.combined.slice(-2500));
    check('lists the four matching models', ['opus-4.6', 'opus-4.5', 'opus-mini', 'opus-free']
      .every(id => block.includes(`opencode/${id}`)), block);
    check('lists no non-matching model', !block.includes('gpt-5') && !block.includes('alpha-model'), block);
    check('offers Search again and Show all',
      block.includes('Search again') && block.includes(`Show all ${LONG_MODELS.length} models`), block);
    checkEqual('picking the match saves its exact live id',
      readConfig(repo).roles.planner.model, 'opencode/opus-4.6');
  }

  {
    console.log('\n#5 long list: typing text searches directly:');
    const repo = ownedSeed(baseConfig({plannerCli: 'opencode'}));
    const binDir = ownedCli();
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['2', '1', '1', 'gpt', '1', '1', '']});
    check('setup exits 0', r.status === 0, r.combined.slice(-2500));
    const block = searchBlock(r.combined, 'gpt', LONG_MODELS.length);
    check('typing a word at the first menu searches it', block.length > 0, r.combined.slice(-2500));
    check('only gpt models are listed', block.includes('opencode/gpt-5') && block.includes('opencode/gpt-5-mini') &&
      !block.includes('opencode/opus'), block);
    checkEqual('the first gpt match is saved', readConfig(repo).roles.planner.model, 'opencode/gpt-5');
  }

  {
    console.log('\n#5 long list: Show all prints today\'s full list:');
    const repo = ownedSeed(baseConfig({plannerCli: 'opencode'}));
    const binDir = ownedCli();
    const idx = shortIndex(LONG_MODELS);
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['2', '1', '1', String(idx.showAll), '1', '1', '']});
    check('setup exits 0', r.status === 0, r.combined.slice(-2500));
    check('prints the old full-list heading',
      count(r.combined, '\nPlanner model (live discovery from opencode)\n') === 1,
      r.combined.slice(-2500));
    check('lists every model, including non-free ones',
      LONG_MODELS.every(id => r.combined.includes(id)), r.combined.slice(-2500));
    checkEqual('the full list default saves an empty model',
      readConfig(repo).roles.planner.model, '');
  }

  {
    console.log('\n#5 long list: Keep current is offered:');
    const repo = ownedSeed(baseConfig({plannerCli: 'opencode', plannerModel: 'opencode/opus-4.5'}));
    const binDir = ownedCli();
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['2', '1', '1', '2', '1', '']});
    check('setup exits 0', r.status === 0, r.combined.slice(-2500));
    check('shows Keep current with the saved model',
      r.combined.includes('Keep current: opencode/opus-4.5'), r.combined.slice(-2500));
    checkEqual('Keep current preserves the model',
      readConfig(repo).roles.planner.model, 'opencode/opus-4.5');
  }

  {
    console.log('\n#5 short list is unchanged:');
    const repo = ownedSeed(baseConfig({plannerCli: 'opencode'}));
    const binDir = ownedCli({models: SHORT_MODELS});
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['2', '1', '1', '2', '1', '']});
    check('setup exits 0', r.status === 0, r.combined.slice(-2500));
    check('keeps the old heading', r.combined.includes('Planner model (live discovery from opencode)'), r.combined.slice(-2500));
    check('adds no short-menu options',
      !r.combined.includes('Search by name') && !r.combined.includes('Show all'), r.combined.slice(-2500));
    check('lists all short-list models', SHORT_MODELS.every(id => r.combined.includes(id)), r.combined.slice(-2500));
    checkEqual('picking option 2 saves the first model',
      readConfig(repo).roles.planner.model, 'opencode/short-one');
  }

  // ── #6: `ap setup` over an existing config ──────────────────────────
  {
    console.log('\n#6 existing config + N:');
    const repo = ownedSeed(baseConfig());
    const binDir = ownedCli({claude: true, opencode: false});
    const file = path.join(repo, '.autopilot', 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    const r = await runSetup({mode: '--wizard', repo, binDir, answers: ['n']});
    check('exits 0', r.status === 0, r.combined.slice(-2000));
    check('prints the already-set-up notice',
      r.combined.includes('This project is already set up (.autopilot/config.json).') &&
      r.combined.includes('  To change one thing: ap config  (or ap config --role implementer)'),
      r.combined.slice(-2000));
    check('asks the restart yes/no', r.combined.includes('Run the full setup again from the start? [y/N]:'), r.combined.slice(-2000));
    check('prints Nothing changed.', r.combined.includes('Nothing changed.'), r.combined.slice(-2000));
    check('does not continue the wizard', !r.combined.includes('Press Enter to continue to role configuration'), r.combined.slice(-2000));
    check('config is byte-identical', fs.readFileSync(file, 'utf8') === before);
  }

  {
    console.log('\n#6 existing config + y:');
    const repo = ownedSeed(baseConfig());
    const binDir = ownedCli({claude: true, opencode: false});
    const r = await runSetup({mode: '--wizard', repo, binDir, answers: ['y', ...Array(30).fill('')]});
    check('exits 0', r.status === 0, r.combined.slice(-3000));
    check('continues after yes',
      r.combined.includes('Planner CLI') &&
      r.combined.includes('✓ Planning: Standalone'), r.combined.slice(-3000));
    check('does not print Nothing changed.', !r.combined.includes('Nothing changed.'), r.combined.slice(-3000));
  }

  {
    console.log('\n#6 ap config never asks:');
    const repo = ownedSeed(baseConfig());
    const binDir = ownedCli({claude: true, opencode: false});
    const r = await runSetup({mode: '--edit', repo, binDir, answers: ['1', ...Array(30).fill('')]});
    check('exits 0', r.status === 0, r.combined.slice(-2500));
    check('no already-set-up notice', !r.combined.includes('This project is already set up'), r.combined.slice(-2500));
    check('no restart question', !r.combined.includes('Run the full setup again from the start?'), r.combined.slice(-2500));
  }

  {
    console.log('\n#6 missing config never asks:');
    const repo = ownedRepo();
    const binDir = ownedCli({claude: true, opencode: false});
    const r = await runSetup({mode: '--wizard', repo, binDir, answers: Array(30).fill('')});
    check('exits 0', r.status === 0, r.combined.slice(-2500));
    check('no already-set-up notice', !r.combined.includes('This project is already set up'), r.combined.slice(-2500));
    check('no restart question', !r.combined.includes('Run the full setup again from the start?'), r.combined.slice(-2500));
  }
} finally {
  for (const repo of repos) {
    try { fs.rmSync(repo, {recursive: true, force: true}); } catch { /* best effort */ }
  }
  for (const binDir of binDirs) {
    try { fs.rmSync(binDir, {recursive: true, force: true}); } catch { /* best effort */ }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
