import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillRoot } from './paths.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project autopilot '));
try {
  const nested = path.join(tempRoot, 'repo with spaces');
  fs.mkdirSync(nested, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(skillRoot, 'scripts', 'doctor.mjs'), '--repo', nested], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false
  });
  // Trusted-release policy: the source tree is not an installer-owned
  // verified release, so doctor must fail closed. Regression target is
  // path-with-spaces robustness: a clean integrity block, not a quoting or
  // path-parsing failure.
  assert.notEqual(r.status, 0, 'mutable-tree execution must exit non-zero');
  const combined = `${r.stdout}\n${r.stderr}`;
  assert.match(combined, /BLOCKED_INTEGRITY \[UNTRUSTED_RELEASE_LOCATION\]/);
  assert.doesNotMatch(combined, /ReferenceError|SyntaxError|EINVAL|ENOENT/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log('Path-with-spaces regression PASS');
