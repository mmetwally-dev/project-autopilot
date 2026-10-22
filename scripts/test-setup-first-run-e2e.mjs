#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {detectPlatformCapabilities, platformKindLabel, bubblewrapLabel} from './platform-capabilities.mjs';

// Drives setup.mjs's readline wizard the way a real terminal would: each
// canned answer is written only in response to newly observed stdout
// (i.e. once the child has actually printed something, proving it's
// alive and blocked on the next prompt), and stdin is never closed while
// the child is still running.
//
// `spawnSync({input: ...})` cannot do this safely: it writes the whole
// answer block and closes (EOF's) the child's stdin essentially
// immediately, before setup.mjs's real async CLI-probing work has even
// gotten far enough to create its readline interface. Node's readline
// closes unconditionally on an 'end' from its input stream, discarding
// any buffered-but-not-yet-requested answers — so the very first
// `rl.question()` call throws ERR_USE_AFTER_CLOSE and setup.mjs exits
// nonzero. That crash doesn't match any of this test's original crash
// patterns, so earlier versions of this test silently treated it as a
// pass. Pumping answers only after observed output sidesteps the race
// entirely, since stdin is never closed until the child has already
// exited on its own.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setup = path.join(here, 'setup.mjs');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-setup-e2e-'));
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fake-cli-'));
const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
if (process.platform === 'win32') {
  const body = '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n';
  fs.writeFileSync(fakeClaude, body);
} else {
  // adapter-drivers.mjs's resolveClaudeBinary treats any shebang ("#!")
  // script named `claude` as an npm-style Windows launcher shim that must
  // point at a claude.exe/claude.com target — a plain POSIX shell script
  // fake gets denied as binary_admission_denied (synthetic missing .exe).
  // A real native ELF is classified as `native` and admitted normally, so
  // the fake CLI here is a copy of a real ELF (`true`) rather than a
  // shell script. Its actual output doesn't matter: `probe()` only checks
  // exit status, and it always exits 0.
  const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  fs.copyFileSync(realTrue, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
}

const delimiter = process.platform === 'win32' ? ';' : ':';
// Hermetic PATH: only the fake CLI plus the bare minimum the OS needs to
// spawn it (cmd.exe / sh). This keeps the canned wizard answers valid
// regardless of what real agent CLIs (opencode, codex, ...) happen to be
// installed globally on the machine running the test.
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

  // The spawn itself must have actually launched and run setup — not
  // failed to spawn, and not been killed by the 30s watchdog timeout.
  // Without these, a later "exit code 0" check could pass vacuously on a
  // result object from a spawn that never really ran setup at all.
  if (r.error) {
    throw new Error(`spawn failed to run setup.mjs: ${r.error.message}\n${combined}`);
  }
  if (r.signal) {
    throw new Error(`setup.mjs was killed by signal ${r.signal} (likely the watchdog timeout):\n${combined}`);
  }

  if (/ReferenceError|TypeError: Cannot read properties of undefined/.test(combined)) {
    throw new Error(`setup crashed during discovery:\n${combined}`);
  }
  if (/buildDiscoveryCaches/.test(combined)) {
    throw new Error(`setup discovery regression surfaced:\n${combined}`);
  }

  // Real setup integration coverage for the "Execution environment:"
  // block (task 15.1 correction, item D): behaviorally proves setup
  // prints exactly one truthful, non-conflicting block, rather than only
  // unit-testing the formatter in isolation.
  const envBlockMatches = combined.match(/Execution environment:/g) || [];
  if (envBlockMatches.length !== 1) {
    throw new Error(`expected exactly one "Execution environment:" block, found ${envBlockMatches.length}:\n${combined}`);
  }

  const expectedCapabilities = await detectPlatformCapabilities();
  const expectedPlatformLine = `Platform: ${platformKindLabel(expectedCapabilities.platformKind)}`;
  if (!combined.includes(expectedPlatformLine)) {
    throw new Error(`expected setup output to report "${expectedPlatformLine}":\n${combined}`);
  }

  const expectedBubblewrapLine = `Bubblewrap: ${bubblewrapLabel(expectedCapabilities.bubblewrap)}`;
  if (!combined.includes(expectedBubblewrapLine)) {
    throw new Error(`expected setup output to report "${expectedBubblewrapLine}":\n${combined}`);
  }

  if (/Platform \/ network isolation:/.test(combined)) {
    throw new Error(`obsolete "Platform / network isolation:" block still present:\n${combined}`);
  }
  if (/WSL2: present \(native-linux\)/.test(combined)) {
    throw new Error(`obsolete conflicting "WSL2: present (native-linux)" line still present:\n${combined}`);
  }

  // Printing the environment block is not enough on its own — a run that
  // prints it and then crashes/exits nonzero further down the wizard must
  // still fail this test. Require setup to have completed cleanly and
  // actually persisted a config, and require that saved config to be free
  // of any platform/bubblewrap/reviewer-mode field (this detection stays
  // informational-only, never a config write).
  if (r.status !== 0) {
    throw new Error(`setup exited with status ${r.status} (expected 0) after printing the execution-environment block:\n${combined}`);
  }

  const configFile = path.join(repo, '.autopilot', 'config.json');
  if (!fs.existsSync(configFile)) {
    throw new Error(`expected setup to have written ${configFile}, but it does not exist:\n${combined}`);
  }
  let savedConfig;
  try {
    savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`saved config at ${configFile} did not parse as JSON: ${error.message}`);
  }
  const serialized = JSON.stringify(savedConfig).toLowerCase();
  if (/bubblewrap|platform_kind|platformkind|execution_environment|executionenvironment|reviewer_mode|reviewermode/.test(serialized)) {
    throw new Error(`setup persisted a platform/bubblewrap detection field into config.json, which must remain informational-only:\n${JSON.stringify(savedConfig, null, 2)}`);
  }

  console.log('setup first-run e2e regression passed');
  console.log('setup execution-environment integration regression passed');
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
  fs.rmSync(binDir, {recursive: true, force: true});
}
