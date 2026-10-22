#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import { skillRoot as root } from './paths.mjs';
import { discoverCapabilities } from './model-discovery.mjs';
const agents=JSON.parse(fs.readFileSync(path.join(root,'adapters','agents.json'),'utf8')).adapters;
// Backlog #27: the wizard subprocess spawn is load-sensitive; `test-all`
// scales this wait with AP_TEST_TIMEOUT_FACTOR (default 2), standalone runs
// keep factor 1 unless the operator sets it.
const TIMEOUT_FACTOR = (() => {
  const value = Number(process.env.AP_TEST_TIMEOUT_FACTOR);
  return Number.isFinite(value) && value > 0 ? value : 1;
})();

// OpenCode contract-v2 selection wiring: reasoning/effort rides the live
// `--variant` flag (verified against native OpenCode 1.18.22); the historical
// model_suffix variant transport is retired.
assert.equal(agents.opencode.contract_version, 2);
assert.equal(agents.opencode.driver, 'opencode');
assert.equal(agents.opencode.effort_flag, '--variant');
assert.equal(agents.opencode.model_flag, '--model');
assert.notEqual(agents.opencode.variant_mode, 'model_suffix');

const invocation=fs.readFileSync(path.join(root,'scripts','agent-invocation.mjs'),'utf8');
assert.match(invocation,/adapter\.effort_flag, role\.reasoning/);
const setup=fs.readFileSync(path.join(root,'scripts','setup.mjs'),'utf8');
assert.match(setup,/effectiveMeta\./);
console.log('OpenCode variant wiring tests passed');

// ==========================================================================
// Behavioral regression: the static wiring above was always correct, but the
// WIZARD never actually surfaced a reasoning/effort prompt for OpenCode at
// all — just the model picker. Root causes, both fixed alongside this test:
//   1. collectHelpText()'s help_subcommands mechanism pushed a 3-element
//      tuple that the consuming loop destructured as 2, silently dropping
//      '--help' and skipping the attempt entirely (dead code, never
//      exercised before opencode's `help_args` needed it).
//   2. discoverCapabilities()'s effort-flag probe only searched literal
//      "--effort"/"--reasoning-effort" text, never the adapter's own
//      declared effort_flag — so OpenCode's "--variant" was never found
//      even when present in the collected help text.
//   3. Even once effort_flag was live-detected, OpenCode's live models
//      carry no "reasoning" field, only "variants" — pickModelAndCapabilities
//      never mapped one to the other, so the prompt fell back to bare
//      free-text with no menu.
// This section proves all three against a deterministic fake `opencode`,
// end-to-end through the real setup.mjs wizard — not just the fixed units
// in isolation.
// ==========================================================================
{
  // --- 3a. discoverCapabilities() unit-level: effort detected via the
  // adapter's own declared flag, and the variant/effort collision guard
  // prevents double-purposing the same literal flag as two capabilities.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-opencode-effort-'));
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

  try {
    const caps = await discoverCapabilities({...agents.opencode, binary});
    assert.equal(caps.model, true, 'model flag must still be detected');
    assert.equal(caps.effort, true, 'effort must be detected via the declared --variant flag');
    assert.equal(caps.effort_flag, '--variant');
    assert.equal(caps.variant, false, 'variant must NOT be separately detected — it is the same flag as effort, not a second capability');
    assert.equal(caps.variant_flag, null);
    console.log('PASS: discoverCapabilities() detects OpenCode effort via its declared --variant flag, with no effort/variant double-assignment');

    // --- 3b. End-to-end: the real wizard renders a NUMBERED MENU built
    // from the live model's variants, not a bare free-text prompt.
    function runSetupInteractively({execPath, args, cwd, env, script, stopAt, timeoutMs}) {
      return new Promise(resolve => {
        const child = spawn(execPath, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
        let stdout = '', stderr = '', scriptIndex = 0, settled = false;
        const settle = (status, signal) => { if (settled) return; settled = true; clearTimeout(watchdog); resolve({status, signal, stdout, stderr}); };
        const pump = () => {
          while (scriptIndex < script.length && script[scriptIndex].match.test(stdout)) {
            const {answer} = script[scriptIndex]; scriptIndex += 1;
            try { child.stdin.write(`${answer}\n`); } catch { /* stdin already closed */ }
          }
          if (stopAt.test(stdout)) { try { child.kill('SIGTERM'); } catch { /* already dead */ } }
        };
        child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); pump(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.on('error', () => settle(null, null));
        const watchdog = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already dead */ } }, timeoutMs);
        child.on('close', (code, signal) => settle(code, signal));
      });
    }

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-opencode-effort-repo-'));
    try {
      const delimiter = process.platform === 'win32' ? ';' : ':';
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const systemDirs = process.platform === 'win32'
        ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
        : ['/usr/bin', '/bin'];
      const env = {...process.env, PATH: [temporary, ...systemDirs].join(delimiter)};
      const setupScript = path.join(root, 'scripts', 'setup.mjs');
      const r = await runSetupInteractively({
        execPath: process.execPath,
        args: [setupScript, '--wizard', '--repo', repo],
        cwd: root,
        env,
        script: [
          {match: /Press Enter to continue/, answer: ''},
          {match: /\nPlanner CLI\n/, answer: '1'},
          {match: /Planner model \(live discovery from opencode\)/, answer: '2'}
        ],
        stopAt: /Planner reasoning\/effort/,
        timeoutMs: Math.ceil(30000 * TIMEOUT_FACTOR)
      });
      const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
      assert.ok(combined.trim().length > 0, 'setup.mjs must produce output');
      assert.doesNotMatch(combined, /ReferenceError|TypeError: Cannot read properties of undefined/, combined);
      assert.match(combined, /Planner reasoning\/effort \(for selected model\)/, `expected a MENU heading, got:\n${combined}`);
      assert.match(combined, /1\) Use CLI default\s*\n2\) low\s*\n3\) medium\s*\n4\) high/, `expected the menu built from the model's live variants, got:\n${combined}`);
      console.log('PASS: real setup.mjs wizard renders a numbered reasoning/effort menu for OpenCode, built from the live model\'s variants');
    } finally {
      fs.rmSync(repo, {recursive: true, force: true});
    }
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}
