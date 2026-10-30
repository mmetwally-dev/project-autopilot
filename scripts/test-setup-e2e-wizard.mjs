#!/usr/bin/env node
// First-run wizard E2E question: a UI repo answered yes stores tests.e2e=playwright and
// tests.e2e_setup_pending=true; no stores "none" and leaves the marker unset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setup = path.join(here, 'setup.mjs');
let failed = 0;
const check = (n, c) => { if (!c) { failed++; console.log('FAIL', n); } else console.log('ok', n); };

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2ew-cli-'));
const fakeClaude = path.join(binDir, 'claude');
fs.copyFileSync(fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true', fakeClaude);
fs.chmodSync(fakeClaude, 0o755);
const E2E_AT = 13;
const env = {...process.env, PATH: [binDir, '/usr/bin', '/bin'].join(':')};

// Forced-stdin mode reads the whole answer block up front, so answers are positional: empty
// lines keep every default (the E2E default is yes) and "no" is placed at line `at`. The E2E
// question is the 14th answer (index 13) of this fixture's wizard; if a question is added or
// removed before it, E2E_AT must move (the neighbour checks below fail first).
function run(repo, at) {
  const lines = Array.from({length: 60}, (_, i) => (i === at ? 'no' : ''));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setup, '--wizard', '--repo', repo], {
      cwd: root, env: {...env, AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'}, stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', c => { out += c.toString('utf8'); });
    child.stderr.on('data', c => { out += c.toString('utf8'); });
    child.on('close', code => { clearTimeout(timer); resolve({code, out}); });
    child.stdin.end(lines.join('\n') + '\n');
  });
}

async function scenario(at) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2ew-repo-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({dependencies: {react: '1'}}));
  try {
    const r = await run(repo, at);
    const file = path.join(repo, '.autopilot', 'config.json');
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return {r, cfg};
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

try {
  const yes = await scenario(-1);
  check('yes: stores playwright', yes.cfg?.tests?.e2e === 'playwright');
  check('yes: pending true', yes.cfg?.tests?.e2e_setup_pending === true);
  const no = await scenario(E2E_AT);
  const before = await scenario(E2E_AT - 1);
  const after = await scenario(E2E_AT + 1);
  check('answer position: neighbours do not answer E2E',
    before.cfg?.tests?.e2e === 'playwright' && after.cfg?.tests?.e2e === 'playwright');
  check('no: stores none', no.cfg?.tests?.e2e === 'none');
  check('no: pending unset', no.cfg?.tests && !('e2e_setup_pending' in no.cfg.tests));
} finally {
  fs.rmSync(binDir, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
