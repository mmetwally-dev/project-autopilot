#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {networkIsolationPrefix} from './shell-guard.mjs';

// Regression for a real bug in setup.mjs's networkSetting(): it used to
// probe isolation availability with only a bare `unshare --net -- true`
// check, duplicating (incompletely) the logic that shell-guard.mjs's
// networkIsolationPrefix() already implements correctly, including the
// `-Urn` (user + net namespace) fallback required on unprivileged
// environments such as WSL2, where the bare `--net` form is denied but the
// combined form succeeds. Because the wizard's own probe didn't know about
// that fallback, it always reported isolation as UNAVAILABLE on WSL2 and
// asked "Allow verify/gates execution without network isolation?" even
// though shell-guard.mjs — the code that actually runs verify/gate
// commands — would have used working isolation regardless of the answer.
// A user answering that misleading prompt could believe they were opting
// out of protection that, in reality, was never absent.
//
// The fix makes networkSetting() call the same networkIsolationPrefix()
// used at run time, so the wizard's belief about isolation availability is
// always consistent with what shell-guard.mjs will actually do.
//
// This test does NOT hardcode an expected true/false for "is isolation
// available on this machine" — that would just be re-asserting today's
// environment and would silently stop testing anything the day the test
// host changes. Instead it calls the real networkIsolationPrefix() itself
// to compute live ground truth, then drives the real setup.mjs wizard
// end-to-end and asserts the prompt's presence/absence matches that ground
// truth — on Linux/WSL2 (where isolation is normally available via the
// fallback) the prompt must be ABSENT; on a platform/environment where no
// working isolation exists at all, the prompt must still appear.

function runSetupInteractively({execPath, args, cwd, env, answers, timeoutMs}) {
  return new Promise(resolve => {
    const child = spawn(execPath, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let answerIndex = 0;
    let settled = false;
    let spawnError = null;
    let timedOut = false;

    const sendNextAnswer = () => {
      if (answerIndex >= answers.length) return;
      const line = answers[answerIndex++];
      try {
        child.stdin.write(`${line}\n`);
      } catch {
        // stdin already closed (child exited) — nothing left to answer.
      }
    };

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      sendNextAnswer();
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    child.on('error', error => { spawnError = error; });

    const watchdog = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }, timeoutMs);

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { child.stdin.end(); } catch { /* already closed */ }
      resolve({status: code, signal: timedOut ? (signal || 'SIGTERM') : signal, error: spawnError, stdout, stderr});
    });
  });
}

// Ground truth: the same function shell-guard.mjs uses at real command-run
// time, called directly here — not simulated, not assumed.
const liveIsolationAvailable = !!networkIsolationPrefix();
console.log(`Live networkIsolationPrefix() on this machine: ${liveIsolationAvailable ? JSON.stringify(networkIsolationPrefix()) : 'null (unavailable)'}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setup = path.join(here, 'setup.mjs');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-netiso-e2e-'));
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-netiso-fake-cli-'));
const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
if (process.platform === 'win32') {
  const body = '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n';
  fs.writeFileSync(fakeClaude, body);
} else {
  const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  fs.copyFileSync(realTrue, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
}

const delimiter = process.platform === 'win32' ? ';' : ':';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemDirs = process.platform === 'win32'
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ['/usr/bin', '/bin'];
const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter)};

try {
  const r = await runSetupInteractively({
    execPath: process.execPath,
    args: [setup, '--wizard', '--repo', repo],
    cwd: root,
    env,
    answers: Array.from({length: 80}, (_, i) => (i % 2 === 0 ? '' : '1')),
    timeoutMs: 30000
  });
  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;

  if (r.error) {
    throw new Error(`spawn failed to run setup.mjs: ${r.error.message}\n${combined}`);
  }
  if (r.signal) {
    throw new Error(`setup.mjs was killed by signal ${r.signal} (likely the watchdog timeout):\n${combined}`);
  }
  if (/ReferenceError|TypeError: Cannot read properties of undefined/.test(combined)) {
    throw new Error(`setup crashed during discovery:\n${combined}`);
  }
  if (r.status !== 0) {
    throw new Error(`setup exited with status ${r.status} (expected 0):\n${combined}`);
  }

  const promptPresent = /Allow verify\/gates execution without network isolation\?/.test(combined);

  if (liveIsolationAvailable && promptPresent) {
    throw new Error(
      `networkIsolationPrefix() reports isolation IS available on this machine, but the wizard ` +
      `still printed the "Allow verify/gates execution without network isolation?" prompt — the ` +
      `detection-fallback fix in networkSetting() is not wired correctly:\n${combined}`
    );
  }
  if (!liveIsolationAvailable && !promptPresent) {
    throw new Error(
      `networkIsolationPrefix() reports isolation is UNAVAILABLE on this machine, but the wizard ` +
      `never printed the "Allow verify/gates execution without network isolation?" prompt — the ` +
      `wizard is not warning the user when it should:\n${combined}`
    );
  }

  const configFile = path.join(repo, '.autopilot', 'config.json');
  if (!fs.existsSync(configFile)) {
    throw new Error(`expected setup to have written ${configFile}, but it does not exist:\n${combined}`);
  }
  const savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (typeof savedConfig?.tests?.gate_network !== 'boolean') {
    throw new Error(`expected tests.gate_network to be a boolean in saved config, got: ${JSON.stringify(savedConfig?.tests)}`);
  }
  if (liveIsolationAvailable && savedConfig.tests.gate_network !== false) {
    throw new Error(
      `isolation is available and the prompt was correctly skipped, but gates.network_isolation ` +
      `was saved as ${savedConfig.tests.gate_network} instead of the secure default false`
    );
  }

  console.log(
    liveIsolationAvailable
      ? 'PASS: isolation is available on this machine (via networkIsolationPrefix fallback) and the wizard correctly skipped the network-isolation opt-out prompt'
      : 'PASS: isolation is unavailable on this machine and the wizard correctly showed the network-isolation opt-out prompt'
  );
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
  fs.rmSync(binDir, {recursive: true, force: true});
}
