#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRoleSelection } from './config-validation.mjs';

// Regression for a real bug in config-validation.mjs's validateModelSelection:
// it only ever checked role.reasoning against match.reasoning, but
// model-discovery.mjs hardcodes reasoning:[] for OpenCode catalog entries —
// their live, model-specific effort data lives in match.variants instead
// (discoverOpenCodeVariants()). Because the validator never looked at
// variants, every OpenCode role with a reasoning value selected always fell
// into the "live catalog did not expose model-specific reasoning levels;
// ... model-unverified" warning, even though the live catalog DID have
// verified, model-specific data — it was just under a different field name.
// Worse, the error branch had the same blind spot: an actually-unsupported
// reasoning value for a given OpenCode model was never rejected either.
//
// This builds a real fake `opencode` binary (same technique as
// test-opencode-variants.mjs) so the live discovery path
// (discoverFromOpenCode -> discoverModelCatalog -> discoverAgentContract)
// really runs and really returns reasoning:[] + variants:[...], then drives
// the real, exported validateRoleSelection() end-to-end.

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cv-opencode-'));
const server = path.join(temporary, 'fake-opencode.mjs');
fs.writeFileSync(server, [
  'const a = process.argv.slice(2);',
  'if (a[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
  'if (a[0] === "--help") { process.stdout.write("Usage: opencode\\n  -m, --model <name>\\n"); process.exit(0); }',
  'if (a[0] === "run" && a[1] === "--help") { process.stdout.write("Usage: opencode run\\n      --variant  model variant (provider-specific reasoning effort, e.g., high, max, minimal)\\n"); process.exit(0); }',
  'if (a[0] === "models" && a[1] === "--verbose") {',
  '  process.stdout.write("opencode/fake-model\\n" + JSON.stringify({name:"Fake OpenCode Model", variants:{low:{},medium:{},high:{}}}) + "\\n");',
  '  process.exit(0);',
  '}',
  'process.exit(0);'
].join('\n'));
let binary;
if (process.platform === 'win32') {
  binary = path.join(temporary, 'opencode.cmd');
  fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`);
} else {
  binary = path.join(temporary, 'opencode');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
  fs.chmodSync(binary, 0o755);
}

const adapter = {
  binary,
  probe: ['--version'],
  write: ['run', '--format', 'json', '--auto'],
  read_only: ['run', '--format', 'json', '--agent', 'plan'],
  model_flag: '--model',
  effort_flag: '--variant',
  variant_flag: null,
  help_args: ['run', '--help'],
  model_discovery: 'opencode_models'
};

try {
  // 1) A reasoning value that IS one of the model's live variants must be
  // accepted as verified — no "model-unverified" warning.
  const ok = await validateRoleSelection({
    roleName: 'implementer',
    role: {adapter: 'opencode', model: 'opencode/fake-model', reasoning: 'high', variant: '', resume: false},
    adapter,
    agents: {opencode: adapter}
  });
  assert.equal(ok.valid, true, `expected valid config, got errors: ${JSON.stringify(ok.errors)}`);
  assert.ok(
    !ok.warnings.some(w => w.includes('model-unverified')),
    `expected no model-unverified warning for a real live variant, got: ${JSON.stringify(ok.warnings)}`
  );
  console.log('PASS: a reasoning value present in the model\'s live variants is accepted with no false "model-unverified" warning');

  // 2) A reasoning value NOT among the model's live variants must still be
  // rejected as an error (proves the fix didn't just silence validation).
  const bad = await validateRoleSelection({
    roleName: 'implementer',
    role: {adapter: 'opencode', model: 'opencode/fake-model', reasoning: 'not-a-real-variant', variant: '', resume: false},
    adapter,
    agents: {opencode: adapter}
  });
  assert.equal(bad.valid, false, 'expected an invalid config for an unsupported reasoning value');
  assert.ok(
    bad.errors.some(e => e.includes("reasoning 'not-a-real-variant' is not supported by model")),
    `expected a reasoning-not-supported error, got: ${JSON.stringify(bad.errors)}`
  );
  console.log('PASS: a reasoning value absent from the model\'s live variants is still correctly rejected as an error');
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

console.log('config-validation opencode-variants regression tests passed');
