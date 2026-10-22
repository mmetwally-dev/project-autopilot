#!/usr/bin/env node
// Task 2.1: antigravity is offered in `ap setup` (--wizard) and `ap config`
// (--edit) alongside the other adapters, with the model list exactly as the
// CLI `models` subcommand exposes it.
//
// Depends on 1.4: discoverAntigravityModels only resolves available after
// the transport denial removal, so the models probe below would fail on the
// pre-1.4 tree.
//
// Hermetic and offline: a PATH-stub node `agy` serves --version/--help and
// the `models` table (the same line format the real CLI prints, grouped by
// discoverAntigravityModels), plus a fake `claude` (the copy-of-`true` ELF
// pattern from test-setup-first-run-e2e.mjs) so the "alongside other
// adapters" assertion is meaningful. No real CLI and no network is touched.
// setup.mjs runs as a subprocess with AUTOPILOT_SETUP_FORCE_INTERACTIVE=1,
// which makes it read its whole answer block from stdin up front.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');

// The raw `agy models` table exactly as the CLI exposes it: effort levels
// ride on -low/-medium/-high id suffixes with a "(Level)" label suffix.
const MODELS_TABLE = [
  'gemini-3.7-flash-high     Gemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low      Gemini 3.7 Flash (Low)',
  'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)'
].join('\n') + '\n';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-'));
const binDir = path.join(scratch, 'bin');
fs.mkdirSync(binDir, { recursive: true });

// PATH-stub `agy`: --version probes alive, --help advertises the flags
// discoverCapabilities reads (--model/--effort/--conversation), `models`
// prints the CLI table, and a bare invocation (collectHelpText also runs
// `[binary]` with empty args) exits 0 printing help.
const agyStub = path.join(binDir, 'agy');
fs.writeFileSync(agyStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('agy-test 0.0.0'); process.exit(0); }
if (args[0] === 'models') { process.stdout.write(${JSON.stringify(MODELS_TABLE)}); process.exit(0); }
console.log('Usage: agy [options]\\n  --model <model>\\n  --effort <level>\\n  --conversation <id>\\n  --continue\\n  --input-format <fmt>\\n  --output-format <fmt>');
process.exit(0);
`);
fs.chmodSync(agyStub, 0o755);

// Fake `claude`: a real native ELF (copy of `true`) so binary admission
// passes; probe() only checks exit status. A shell-script fake would work
// for admission too, but this mirrors the established e2e pattern.
const claudeStub = path.join(binDir, 'claude');
fs.copyFileSync(fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true', claudeStub);
fs.chmodSync(claudeStub, 0o755);

const delimiter = path.delimiter;
const nodeDir = path.dirname(process.execPath);
const stubPath = [binDir, nodeDir, '/usr/bin', '/bin'].join(delimiter);

const previousPath = process.env.PATH;
process.env.PATH = stubPath;

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

try {
  // ── A. Discovery offers antigravity's models as the CLI exposes them ──
  const { adapterDriver } = await import('./adapter-drivers.mjs');
  const { resolveAdapterTransport } = await import('./adapter-transport.mjs');
  const { discoverModelCatalog, parseAntigravityModels } = await import('./model-discovery.mjs');
  const { discoverAgentContract } = await import('./agent-contract.mjs');

  const driver = adapterDriver('antigravity');
  check('adapterDriver("antigravity") resolves', !!driver);

  // Mirrors scripts/model-discovery.mjs discoverAntigravityModels exactly:
  // bare binary name plus the `models` argv, no mode.
  const modelsTransport = resolveAdapterTransport({ driver, request: { binary: 'agy', args: ['models'] } });
  check('agy models transport resolves available', modelsTransport.available === true, `reason: ${modelsTransport.reason}`);

  const catalog = await discoverModelCatalog({ binary: 'agy', model_discovery: 'antigravity_models' });
  const expected = parseAntigravityModels(MODELS_TABLE);
  check('discovered catalog matches the CLI models table parsed as exposed',
    JSON.stringify(catalog) === JSON.stringify(expected),
    `got: ${JSON.stringify(catalog)}`);
  const flash = catalog.find(x => x.id === 'gemini-3.7-flash');
  check('effort-suffixed ids group with reasoning levels',
    !!flash && JSON.stringify(flash.reasoning) === JSON.stringify(['low', 'medium', 'high']) &&
    flash.effortModelIds?.medium === 'gemini-3.7-flash-medium',
    `got: ${JSON.stringify(flash)}`);

  const agents = JSON.parse(fs.readFileSync(path.join(root, 'adapters', 'agents.json'), 'utf8')).adapters;
  check('agents.json declares antigravity_models discovery',
    agents?.antigravity?.model_discovery === 'antigravity_models' && agents?.antigravity?.binary === 'agy');
  const contract = await discoverAgentContract('antigravity', agents.antigravity);
  check('agent contract reports a live model list',
    contract?.models?.status === 'reported' && Array.isArray(contract?.models?.items) && contract.models.items.length > 0,
    `got: ${JSON.stringify(contract?.models)}`);

  // ── B. `ap setup` (--wizard) lists antigravity with discovered models ──
  const repo = fs.mkdtempSync(path.join(scratch, 'repo-'));
  // Prompts in order: continue, planner adapter, planner fallback?,
  // reviewer adapter, reviewer fallback?, implementer adapter ('2' =
  // antigravity), implementer model (default), implementer reasoning
  // (default), implementer fallback?, code-reviewer adapter, fallback?,
  // verifier adapter, fallback? — then gates/runtime; blanks take defaults.
  const wizardAnswers = ['', '', '', '', '', '2', '', '', '', '', '', '', '', ...Array(300).fill('')].join('\n');
  const wizardEnv = { ...process.env, PATH: stubPath, AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1' };
  const wizard = spawnSync(process.execPath, [setupScript, '--wizard', '--repo', repo],
    { cwd: root, env: wizardEnv, input: wizardAnswers, encoding: 'utf8', timeout: 120000 });
  const wizardOut = `${wizard.stdout || ''}\n${wizard.stderr || ''}`;
  check('setup wizard exits 0', wizard.status === 0,
    `status=${wizard.status} signal=${wizard.signal} error=${wizard.error?.message}\n${wizardOut.slice(-3000)}`);
  check('wizard lists antigravity availability', wizardOut.includes('✓ antigravity (agy)'), wizardOut.slice(-3000));
  check('wizard lists antigravity alongside claude', wizardOut.includes('✓ claude (claude)'), wizardOut.slice(-3000));
  check('wizard model menu is live discovery from agy', wizardOut.includes('live discovery from agy'), wizardOut.slice(-3000));
  check('wizard menu shows a discovered model label', wizardOut.includes('Gemini 3.7 Flash'), wizardOut.slice(-3000));

  const saved = JSON.parse(fs.readFileSync(path.join(repo, '.autopilot', 'config.json'), 'utf8'));
  check('wizard saves implementer on antigravity',
    saved?.roles?.implementer?.cli === 'antigravity',
    `got: ${JSON.stringify(saved?.roles?.implementer)}`);

  // ── C. `ap config` (--edit) offers the same antigravity model list ──
  // All-blank answers keep every current value; the implementer stays on
  // antigravity so its model menu must again be the live agy catalog.
  const editAnswers = Array(320).fill('').join('\n');
  const edit = spawnSync(process.execPath, [setupScript, '--edit', '--repo', repo],
    { cwd: root, env: { ...process.env, PATH: stubPath, AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1' }, input: editAnswers, encoding: 'utf8', timeout: 120000 });
  const editOut = `${edit.stdout || ''}\n${edit.stderr || ''}`;
  check('config edit exits 0', edit.status === 0,
    `status=${edit.status} signal=${edit.signal} error=${edit.error?.message}\n${editOut.slice(-3000)}`);
  check('config edit offers antigravity', editOut.includes('antigravity'), editOut.slice(-3000));
  check('config edit model menu is live discovery from agy', editOut.includes('live discovery from agy'), editOut.slice(-3000));
  check('config edit menu shows a discovered model label', editOut.includes('Gemini 3.7 Flash'), editOut.slice(-3000));
} finally {
  if (previousPath == null) delete process.env.PATH; else process.env.PATH = previousPath;
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  console.log(`test-agy-setup: ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('test-agy-setup: ALL CHECKS PASSED');
