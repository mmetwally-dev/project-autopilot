#!/usr/bin/env node
// `ap config` (setup --edit) E2E question: same prompt as the wizard; yes stores tests.e2e=playwright
// and tests.e2e_setup_pending=true when the value was unset; a stored value is not asked again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setup = path.join(here, 'setup.mjs');
const PROMPT = 'Add Playwright? (recommended) [yes/no/cypress]: ';
let failed = 0;
const check = (n, c) => { if (!c) { failed++; console.log('FAIL', n); } else console.log('ok', n); };

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2ec-cli-'));
const fakeClaude = path.join(binDir, 'claude');
fs.copyFileSync(fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true', fakeClaude);
fs.chmodSync(fakeClaude, 0o755);
const env = {...process.env, PATH: [binDir, '/usr/bin', '/bin'].join(':'), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};

function run(repo, flag) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setup, flag, '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', c => { out += c.toString('utf8'); });
    child.stderr.on('data', c => { out += c.toString('utf8'); });
    child.on('close', code => { clearTimeout(timer); resolve({code, out}); });
    child.stdin.end(Array.from({length: 60}, () => '').join('\n') + '\n');
  });
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2ec-repo-'));
const file = path.join(repo, '.autopilot', 'config.json');
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({dependencies: {react: '1'}}));
  const wiz = await run(repo, '--wizard');
  check('wizard run ok', wiz.code === 0);
  const cfg = read();
  delete cfg.tests.e2e;
  delete cfg.tests.e2e_setup_pending;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const edit = await run(repo, '--edit');
  // Forced-stdin mode does not echo prompts, so pin the wording at the source: one prompt string,
  // one ask site, and the wizard and edit paths share the single askE2eChoice call.
  const src = fs.readFileSync(setup, 'utf8');
  check('config: one shared prompt string', src.split(PROMPT).length === 2 && src.includes('ask(E2E_PROMPT)'));
  check('config: single askE2eChoice call site for wizard and edit', src.split('await askE2eChoice(').length === 2);
  check('config run ok', edit.code === 0);
  const after = read();
  check('config yes: stores playwright', after.tests?.e2e === 'playwright');
  check('config yes: pending true', after.tests?.e2e_setup_pending === true);
  // Stored 'none' (default answers would otherwise say yes) must stay 'none' with no pending marker.
  const none = read();
  none.tests.e2e = 'none';
  delete none.tests.e2e_setup_pending;
  fs.writeFileSync(file, JSON.stringify(none, null, 2));
  const keepNone = await run(repo, '--edit');
  check('config: stored none run ok', keepNone.code === 0);
  check('config: stored none kept', read().tests?.e2e === 'none');
  check('config: stored none adds no pending', read().tests?.e2e_setup_pending === undefined);
  // Stored playwright with pending=false must not flip back to true.
  const pf = read();
  pf.tests.e2e = 'playwright';
  pf.tests.e2e_setup_pending = false;
  fs.writeFileSync(file, JSON.stringify(pf, null, 2));
  const keepPf = await run(repo, '--edit');
  check('config: stored pending=false run ok', keepPf.code === 0);
  check('config: stored playwright kept', read().tests?.e2e === 'playwright');
  check('config: pending=false unchanged', read().tests?.e2e_setup_pending === false);
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
  fs.rmSync(binDir, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
