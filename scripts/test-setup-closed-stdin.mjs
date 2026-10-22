import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
}

for (const input of ['', '\n\n']) {
  console.log(`\nsetup with stdin ${JSON.stringify(input)}:`);
  const d = mkdtempSync(join(tmpdir(), 'setup-closed-'));
  try {
    spawnSync('git', ['init', '-q', d]);
    const r = spawnSync('node', [join(root, 'bin/ap.cjs'), 'setup', '--repo', d], {
      input, encoding: 'utf8', timeout: 60000
    });
    const all = `${r.stdout}\n${r.stderr}`;
    assert(r.status !== 0 && r.status !== null, `non-zero exit (got ${r.status})`);
    assert(r.stderr.includes('input ended before setup finished'), 'stderr has the clear message');
    assert(r.stderr.includes('Configuration not saved'), 'message says configuration not saved');
    assert(!all.includes('ERR_USE_AFTER_CLOSE'), 'no ERR_USE_AFTER_CLOSE');
    assert(!all.includes('    at '), 'no stack frames');
    assert(!existsSync(join(d, '.autopilot', 'config.json')), 'no config.json written');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
