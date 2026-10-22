import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillRoot as sourceRoot } from './paths.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-install-space-test-'));
const installRoot = path.join(tempRoot, 'Project Autopilot Installed');
const repoRoot = path.join(tempRoot, 'target repo');
fs.cpSync(sourceRoot, installRoot, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });

try {
  const doctor = spawnSync(
    process.execPath,
    [path.join(installRoot, 'scripts', 'doctor.mjs'), '--repo', repoRoot],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false }
  );
  // Trusted-release policy: a plain tree copy is not installer-owned, so the
  // entrypoint must fail closed. The regression target is path-with-spaces
  // robustness: the block must be the clean integrity error, not a crash,
  // quoting artifact, or ReferenceError.
  assert.notEqual(doctor.status, 0, 'unsigned copy execution must exit non-zero');
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  assert.match(combined, /BLOCKED_INTEGRITY \[UNTRUSTED_RELEASE_LOCATION\]/);
  assert.doesNotMatch(combined, /ReferenceError|SyntaxError|EINVAL/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log('Install-path-with-spaces regression PASS');
