import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import { skillRoot as root } from './paths.mjs';
const setup = path.join(root, 'scripts', 'setup.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-setup-ux-'));

// ap config before first setup must not enter the reconfiguration wizard.
// Trusted-release policy: the mutable source tree fails closed before any UX
// can render, so the runtime expectation is the clean integrity block.
const pre = spawnSync(process.execPath, [setup, '--edit', '--repo', tmp], {
  cwd: tmp,
  encoding: 'utf8',
  input: ''
});
assert.notEqual(pre.status, 0, 'mutable-tree execution must exit non-zero');
{
  const combined = `${pre.stdout}\n${pre.stderr}`;
  assert.match(combined, /BLOCKED_INTEGRITY \[UNTRUSTED_RELEASE_LOCATION\]/);
  assert.doesNotMatch(combined, /ReferenceError|SyntaxError|EINVAL/);
}

const source = fs.readFileSync(setup, 'utf8');
assert.match(source, /if \(wizardMode\) \{\n      console\.log\("CLI availability:"\)/);
assert.match(source, /console\.log\("\\nFramework availability:"\)/);
assert.match(source, /console\.log\("\\nBrowser testing:"\)/);
assert.match(source, /printCurrentSummary\(current\);/);
const summaryIndex = source.indexOf("printCurrentSummary(current);");
const browserIndex = source.indexOf('console.log("\nBrowser testing:");');
const continueIndex = source.indexOf("Press Enter to continue to role configuration...");
assert.ok(summaryIndex > browserIndex, "current configuration should be after browser testing");
assert.ok(summaryIndex < continueIndex, "current configuration should be before the continue prompt");
assert.match(source, /Press Enter to continue to role configuration/);
assert.match(source, /const SCOPE = \{/);
assert.match(source, /"All configuration"/);
assert.match(source, /"One role"/);
assert.match(source, /"Framework \/ safety"/);
assert.match(source, /if \(wizardMode\)/);
const editModeIndex = source.indexOf('} else if (editMode) {');
const editModeBlock = source.slice(editModeIndex, editModeIndex + 1800);
const scopeIndex = editModeBlock.indexOf('Configuration scope:');
const editCurrentIndex = editModeBlock.indexOf('printCurrentSummary(current);');
assert.ok(editModeIndex >= 0, "reconfigure editMode branch should exist");
assert.ok(scopeIndex >= 0, "editMode should show configuration scope");
assert.ok(editCurrentIndex >= 0 && editCurrentIndex < scopeIndex,
  "reconfigure must show current role configuration before the scope selector");
assert.equal((editModeBlock.match(/printCurrentSummary\(current\);/g) || []).length, 1,
  "editMode must render current role configuration exactly once before the scope selector");
const editHead = source.slice(editModeIndex - 500, editModeIndex);
assert.ok(!editHead.includes('console.log("CLI availability:")'),
  "reconfigure must not render CLI availability");

console.log('setup UX tests passed');
