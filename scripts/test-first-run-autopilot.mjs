import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillRoot } from './paths.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-first-run-'));
const agentsFile = path.join(tmp, 'agents.json');
fs.writeFileSync(agentsFile, JSON.stringify({ adapters: {} }) + '\n');
try {
  const r = spawnSync(process.execPath, [
    path.join(skillRoot, 'scripts', 'autopilot.mjs'),
    'run',
    'test request',
    '--repo',
    tmp
  ], {
    cwd: tmp,
    env: { ...process.env, AUTOPILOT_AGENTS_FILE: agentsFile },
    input: '',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  });
  const combined = `${r.stdout}\n${r.stderr}`;
  assert.notEqual(combined.includes('ReferenceError: base is not defined'), true, combined);
  assert.notEqual(combined.includes('base is not defined'), true, combined);
  // Trusted-release policy: outside an installer-owned verified release the
  // autopilot entrypoint fails closed instead of reading mutable/env-selected
  // configuration (AUTOPILOT_AGENTS_FILE is no longer honored).
  assert.notEqual(r.status, 0, 'mutable-tree execution must exit non-zero');
  assert.match(combined, /BLOCKED_INTEGRITY \[UNTRUSTED_RELEASE_LOCATION\]/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('First-run autopilot regression PASS');
