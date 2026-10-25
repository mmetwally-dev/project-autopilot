#!/usr/bin/env node
'use strict';

// Normal user-space dispatcher. No trusted-release bootstrap, no signature
// verification, no /opt installation, no certification/receipt/admission
// requirement. Runs directly:
//
//   node bin/ap.cjs --help
//   node bin/ap.cjs setup --repo <path>
//   node bin/ap.cjs run --repo <path>
//
// An `ap` shell alias/shim pointing at this file is a convenience only —
// it is never required.

const path = require('node:path');
const {spawnSync, spawn} = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');

const skillRoot = path.resolve(__dirname, '..');

function usage() {
  console.log([
    'Project Autopilot',
    '',
    'Usage:',
    '  ap setup [--repo <path>]',
    '  ap run [request] [--repo <path>] [--stage <planning|implement|review|verify>] [--detach]',
    '  ap commands [--repo <path>]   (re)install agent slash-command files for PATH-detected agents',
    '  ap cancel [reason] [--yes] [--dry-run] [--repo <path>]   end the active mission, stopping a live run first (one plan, one y/N; --dry-run previews, --yes skips)',
    '  ap stop [--yes] [--dry-run] [--repo <path>]   stop the live run but keep the mission (resume with ap run; asks y/N unless --yes)',
    '  ap uninstall [--dry-run] [--yes] [--keep-missions] [--repo <path>]   remove Autopilot from this project: deletes .autopilot/ (--keep-missions archives missions/ at the repo root instead); --dry-run previews, --yes skips the y/N',
    '  ap reset [--scope <key>] [--repo <path>]   bare: clear ALL spent counters; --scope: one key (failure key, continuation scope, standalone-plan-revision, or fallback:<role>; resume after)',
    '  ap rebase [--note "<why>"] [--yes] [--repo <path>]   accept a phase-checkpoint drift after an operator edit (keeps the stage position)',
    '  ap finding list [--scope <key>] [--repo <path>]   list the open review findings the mission is carrying',
    '  ap finding drop <n> [--scope <key>] [--note "<why>"] [--yes] [--repo <path>]   drop finding number <n> (recorded with the note)',
    '  ap config [--repo <path>] [--role <role>]',
    '  ap config show [--repo <path>] [--path <key.path>] [--explain]',
    '  ap config fill [--dry-run] [--repo <path>]   add missing defaults and repair $schema (dry run prints changes)',
    '  ap plan-review <plan-file>',
    '  ap code-review (<range> | <commit> | <diff-file> | <path>) [--range <a..b> | --commit <sha> | --diff-file <file>]',
    '  ap verify-file <criteria-file> [--cmd "<test command>"]',
    '  ap adapter certify <adapter> [--repo <path>]   (no longer required, kept for compatibility)',
    '  ap adapter status <adapter> [--repo <path>]',
    '  ap help',
    '',
    '  --detach: run the mission detached (systemd-run when available, else setsid).',
    '',
    'Setup requires no separate certification step. `ap run` performs a quick,',
    'non-authoritative preflight (binary present, --version/--help works,',
    'configured flags structurally supported, repository/scratch usable) on',
    'every run instead. Read-only roles (plan_reviewer, code_reviewer,',
    'verifier) require WSL2/Linux Strong mode (OS-enforced bubblewrap',
    'containment) or, for SpecKit and standalone projects on Native Windows, Windows',
    'Compatibility mode (disposable-copy isolation — not OS-enforced).',
    'GSD still requires Strong mode.'
  ].join('\n'));
}

function runScript(scriptRelativePath, args, {cwd} = {}) {
  const script = path.join(skillRoot, scriptRelativePath);
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    shell: false,
    ...(cwd ? {cwd} : {})
  });
  if (result.error) {
    console.error(`Failed to launch ${scriptRelativePath}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`${scriptRelativePath} terminated by signal ${result.signal}`);
    return 1;
  }
  return result.status == null ? 1 : result.status;
}

// Conventional Unix shell exit-status mapping for a signal (128 + signal
// number), used only at the delegated-run CLI boundary (see runCommand()
// below) so a delegated mission's termination signal is observable as a
// real, distinguishable exit code rather than collapsing to a generic 1.
const SIGNAL_NUMBERS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15
};
function exitCodeForSignal(signal) {
  const num = SIGNAL_NUMBERS[signal];
  return num ? 128 + num : 1;
}

// Shared exit-code mapping for a delegated (`action === 'delegated'`)
// routing decision. `verb` is the subcommand name for messages ("run" or
// "stop") — the mapping itself is identical for both.
function delegatedResultExit(decision, verb) {
  const result = decision.result || {};
  if (result.error) {
    console.error(`Failed to delegate \`ap ${verb}\` into WSL distro '${decision.distro}': ${result.error}`);
    return 1;
  }
  if (result.timedOut) {
    console.error(`Delegated \`ap ${verb}\` inside WSL distro '${decision.distro}' timed out${result.terminationFailed ? ' and process-tree termination could not be confirmed' : ''}.`);
    return 1;
  }
  if (result.signal) {
    console.error(`Delegated \`ap ${verb}\` terminated by signal ${result.signal}`);
    return exitCodeForSignal(result.signal);
  }
  return result.status == null ? 1 : result.status;
}

// `ap run` routes through scripts/runtime-mode-router.mjs BEFORE
// scripts/autopilot.mjs is ever spawned, so a saved runtime.execution mode
// (task 15.5A/15.5B) is honored — and any routing failure reported — before
// mission state can be created or changed, before any .autopilot/runs
// artifact exists, before planning starts, and before preflight can launch
// any agent CLI. See scripts/runtime-mode-router.mjs for the full contract.
function parseRepoFromArgs(rest) {
  let repo = process.cwd();
  const arr = Array.isArray(rest) ? rest : [];
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] === '--repo' && arr[i + 1]) { repo = path.resolve(arr[i + 1]); i += 1; }
    else if (typeof arr[i] === 'string' && arr[i].startsWith('--repo=')) repo = path.resolve(arr[i].slice('--repo='.length));
  }
  return repo;
}

// The residual request text of a detached `ap run` invocation: known value
// flags (`--repo`, `--mission`, `--stage`, in either spelling) and other flags
// are stripped, exactly as `parseRunArgs()` does for a normal run.
const DETACHED_VALUE_FLAGS = new Set(['--repo', '--mission', '--stage']);
function detachedRequest(rest) {
  const list = Array.isArray(rest) ? rest : [];
  const residual = [];
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]);
    if (DETACHED_VALUE_FLAGS.has(token)) { i += 1; continue; }
    if (/^--(repo|mission|stage)=/.test(token)) continue;
    if (token.startsWith('--')) continue;
    residual.push(token);
  }
  return residual.join(' ').trim();
}

function detachedStamp() {
  return new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
}

function runDetached(rest, options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const spawner = opts.spawner || spawn;
  const spawnSyncFn = opts.spawnSync || spawnSync;
  const restNoDetach = (Array.isArray(rest) ? rest : []).filter((a) => a !== '--detach');
  const repo = parseRepoFromArgs(restNoDetach);
  const request = detachedRequest(restNoDetach);
  let logDir;
  let logPath;
  let unitSuffix;
  let detachedLog = null;
  let previousMission = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(repo, '.autopilot', 'state.json'), 'utf8'));
    previousMission = st.mission || st.missionName || null;
  } catch {}
  if (request) {
    // Backlog #209: a NEW request has no mission yet. Naming the unit/log
    // after `state.json.mission` would report the previous (finished) mission
    // and append this run's output to its log. Use a neutral repo+timestamp
    // unit and a root-level log; autopilot.mjs moves it into the new mission
    // directory once that directory exists.
    const stamp = detachedStamp();
    const repoName = String(path.basename(repo) || 'repo').replace(/[^A-Za-z0-9_.-]/g, '-');
    unitSuffix = `${repoName}-${stamp}`;
    logDir = path.join(repo, '.autopilot');
    logPath = path.join(logDir, `orchestrator-${stamp}.log`);
    detachedLog = logPath;
  } else {
    // Resume/continuation: the mission is already on record, so keep naming
    // the unit, log and already-running check after it.
    const mission = previousMission;
    logDir = mission
      ? path.join(repo, '.autopilot', 'missions', mission)
      : path.join(repo, '.autopilot');
    logPath = path.join(logDir, 'orchestrator.log');
    unitSuffix = mission || crypto.createHash('sha256').update(repo).digest('hex').slice(0, 12);
  }
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const fd = fs.openSync(logPath, 'a');

  let useSystemd = false;
  if (typeof opts.useSystemd === 'boolean') useSystemd = opts.useSystemd;
  else {
    try {
      const r = spawnSyncFn('systemd-run', ['--version'], { stdio: 'ignore' });
      if (r && r.status === 0) {
        const r2 = spawnSyncFn('systemctl', ['--user', 'is-system-running'], { stdio: 'ignore' });
        if (r2 && r2.status === 0) useSystemd = true;
      }
    } catch {}
  }

  const unit = 'ap-' + String(unitSuffix).replace(/[^A-Za-z0-9_.-]/g, '-');
  const apScript = path.join(skillRoot, 'bin', 'ap.cjs');
  // The detached child moves its log into the mission directory once the
  // mission exists (see autopilot.mjs). Pass the path by name only through
  // systemd, like every other forwarded value.
  const hadDetachedLog = Object.prototype.hasOwnProperty.call(process.env, 'AUTOPILOT_DETACHED_LOG');
  const priorDetachedLog = process.env.AUTOPILOT_DETACHED_LOG;
  const hadDetachedRequest = Object.prototype.hasOwnProperty.call(process.env, 'AUTOPILOT_DETACHED_REQUEST');
  const priorDetachedRequest = process.env.AUTOPILOT_DETACHED_REQUEST;
  const hadPreviousMission = Object.prototype.hasOwnProperty.call(process.env, 'AUTOPILOT_DETACHED_PREVIOUS_MISSION');
  const priorPreviousMission = process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION;
  if (detachedLog) {
    process.env.AUTOPILOT_DETACHED_LOG = detachedLog;
    process.env.AUTOPILOT_DETACHED_REQUEST = request;
    if (previousMission) process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION = previousMission;
  }

  try {
    if (useSystemd) {
      // Already running?
      try {
        const r = spawnSyncFn('systemctl', ['--user', 'is-active', unit], { stdio: 'ignore' });
        if (r && r.status === 0) {
          console.log('already running: ' + unit);
          return 1;
        }
      } catch {}
      // Name-only --setenv: systemd-run copies each value from its own
      // environment, so secrets (API keys) never appear in argv / ps.
      const setenvs = ['--setenv=PATH', '--setenv=HOME'];
      if (detachedLog) {
        setenvs.push('--setenv=AUTOPILOT_DETACHED_LOG');
        setenvs.push('--setenv=AUTOPILOT_DETACHED_REQUEST');
        if (previousMission) setenvs.push('--setenv=AUTOPILOT_DETACHED_PREVIOUS_MISSION');
      }
      for (const key of Object.keys(process.env)) {
        if (/^(OPENCODE_|ANTHROPIC_|CLAUDE_)/.test(key) && process.env[key] != null) {
          setenvs.push('--setenv=' + key);
        }
      }
      const args = ['--user', '--unit', unit, '--working-directory=' + repo, '--collect',
        ...setenvs,
        '-p', 'StandardOutput=append:' + logPath,
        '-p', 'StandardError=append:' + logPath,
        process.execPath, apScript, 'run', ...restNoDetach];
      const child = spawner('systemd-run', args, { stdio: ['ignore', fd, fd] });
      const pid = child && child.pid;
      console.log('unit: ' + unit);
      if (pid) console.log('pid: ' + pid);
      console.log('log: ' + logPath);
      console.log('status: systemctl --user status ' + unit);
      try { if (child && typeof child.unref === 'function') child.unref(); } catch {}
      return 0;
    }
    const child = spawner(process.execPath, [apScript, 'run', ...restNoDetach], {
      detached: true,
      stdio: ['ignore', fd, fd],
      ...(detachedLog ? { env: {...process.env, AUTOPILOT_DETACHED_LOG: detachedLog, AUTOPILOT_DETACHED_REQUEST: request} } : {})
    });
    if (child && typeof child.unref === 'function') child.unref();
    const pid = child && child.pid;
    console.log('pid: ' + (pid || ''));
    console.log('log: ' + logPath);
    return 0;
  } finally {
    try { fs.closeSync(fd); } catch {}
    if (detachedLog) {
      if (hadDetachedLog) process.env.AUTOPILOT_DETACHED_LOG = priorDetachedLog;
      else delete process.env.AUTOPILOT_DETACHED_LOG;
      if (hadDetachedRequest) process.env.AUTOPILOT_DETACHED_REQUEST = priorDetachedRequest;
      else delete process.env.AUTOPILOT_DETACHED_REQUEST;
      if (hadPreviousMission) process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION = priorPreviousMission;
      else delete process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION;
    }
  }
}

async function runCommand(rest) {
  if (Array.isArray(rest) && rest.includes('--detach')) return runDetached(rest);
  // `ap run --help` (and `-h`) must keep printing autopilot.mjs's own help
  // text unconditionally, exactly as before this task — routing a request
  // for help through mission-mode discovery/config validation would be a
  // behavior change, not a routing decision.
  if (rest.includes('--help') || rest.includes('-h')) {
    return runScript('scripts/autopilot.mjs', ['run', ...rest]);
  }
  let router;
  try {
    router = await import(pathToFileURL(path.join(skillRoot, 'scripts', 'runtime-mode-router.mjs')).href);
  } catch (error) {
    console.error(`Failed to load the Autopilot runtime mode router: ${error && error.message ? error.message : error}`);
    return 1;
  }

  const route = () => router.routeRun({repoArgs: rest, cwd: process.cwd(), skillRoot, env: process.env});

  let decision;
  try {
    decision = await route();
  } catch (error) {
    console.error(`Runtime mode routing failed: ${error && error.message ? error.message : error}`);
    return 1;
  }

  if (decision.action === 'setup-required') {
    // No .autopilot/config.json exists yet: run the existing Setup wizard
    // exactly once (this file owns that single invocation — the router
    // itself never launches Setup, so its logic is never duplicated), then
    // re-route exactly once against whatever Setup just saved. A second
    // 'setup-required' after a successful Setup run means Setup exited 0
    // without actually producing a valid config — that is a hard failure,
    // not a second Setup attempt, so no Setup/routing loop is possible.
    const setupStatus = runScript('scripts/setup.mjs', ['--wizard', '--repo', decision.repo], {cwd: decision.repo});
    if (setupStatus !== 0) {
      console.error(`ERROR: Setup did not complete successfully (exit ${setupStatus}). Run \`ap setup\` to try again.`);
      return setupStatus || 1;
    }
    try {
      decision = await route();
    } catch (error) {
      console.error(`Runtime mode routing failed after Setup: ${error && error.message ? error.message : error}`);
      return 1;
    }
    if (decision.action === 'setup-required') {
      console.error('ERROR: Setup completed but `.autopilot/config.json` still does not exist for this project. Run `ap setup` again.');
      return 1;
    }
  }

  if (decision.action === 'error') {
    console.error(`ERROR: ${decision.message}`);
    return 2;
  }
  if (decision.action === 'delegated') {
    return delegatedResultExit(decision, 'run');
  }
  if (decision.action === 'proceed' && decision.runtimeLabel) {
    console.log(decision.runtimeLabel);
  }
  // decision.action is 'proceed': continue exactly as before — same
  // subprocess, same inherited stdio, same exit-code handling as every
  // other command.
  return runScript('scripts/autopilot.mjs', ['run', ...rest]);
}

// `ap stop`, `ap cancel` and `ap uninstall` route through the same
// runtime-mode decision as `ap run` so a mission living inside WSL2 is
// handled where it runs (the /proc liveness check only works there — a
// Windows-only check would miss the live run and, for cancel, orphan it
// past the mission end). Difference from `ap run`: cancel, stop and
// uninstall need no config — they read state.json, the process table and
// the .autopilot/ tree only — so every non-delegated outcome (proceed,
// setup-required, error) runs locally instead of launching Setup or failing
// on config state.
async function missionControlRoute(command, rest) {
  if (rest.includes('--help') || rest.includes('-h')) {
    return runScript('scripts/autopilot.mjs', [command, ...rest]);
  }
  let router;
  try {
    router = await import(pathToFileURL(path.join(skillRoot, 'scripts', 'runtime-mode-router.mjs')).href);
  } catch (error) {
    console.error(`Failed to load the Autopilot runtime mode router: ${error && error.message ? error.message : error}`);
    return 1;
  }
  let decision;
  try {
    decision = await router.routeSubcommand({command, repoArgs: rest, cwd: process.cwd(), skillRoot, env: process.env});
  } catch (error) {
    console.error(`Runtime mode routing failed: ${error && error.message ? error.message : error}`);
    return 1;
  }
  if (decision.action === 'delegated') {
    return delegatedResultExit(decision, command);
  }
  // Still runs locally (mission control must work on a broken config), but
  // never silently: a native-Windows check cannot see a run living in WSL,
  // so its "isn't running" would otherwise read as the truth.
  if (decision.action === 'error') {
    console.error(`WARNING: runtime routing failed (${decision.message}) — checking this machine only; a run inside WSL will not be seen.`);
  }
  return runScript('scripts/autopilot.mjs', [command, ...rest]);
}
async function stopCommand(rest) {
  return missionControlRoute('stop', rest);
}
async function cancelRoute(rest) {
  return missionControlRoute('cancel', rest);
}
async function uninstallRoute(rest) {
  return missionControlRoute('uninstall', rest);
}

// Adhoc reviews (mission 091): `ap plan-review`, `ap code-review` and
// `ap verify-file` delegate in-process to the 2.2 runner
// (scripts/adhoc-runner.mjs `runAdhocCommand`), which itself calls the
// Phase 1 helpers and the 2.1 relay entry in order. Exit codes: 0 success
// (the runner already prints verdict+findings), 2 usage/refusal
// (unknown/missing/unreadable input, --help handled below), 1 relay or
// runtime failure.
async function adhocRoute(command, rest) {
  if (rest.includes('--help') || rest.includes('-h')) {
    try {
      const parseMod = await import(pathToFileURL(path.join(skillRoot, 'scripts', 'adhoc-arg-parse.mjs')).href);
      console.log(parseMod.formatAdhocUsage(command));
    } catch (error) {
      console.error(`Failed to load the adhoc arg parser: ${error && error.message ? error.message : error}`);
      return 1;
    }
    return 0;
  }
  let runner;
  try {
    runner = await import(pathToFileURL(path.join(skillRoot, 'scripts', 'adhoc-runner.mjs')).href);
  } catch (error) {
    console.error(`Failed to load the adhoc runner: ${error && error.message ? error.message : error}`);
    return 1;
  }
  let result;
  try {
    result = await runner.runAdhocCommand(command, rest);
  } catch (error) {
    console.error(`ERROR: ${error && error.message ? error.message : error}`);
    return 1;
  }
  if (!result || !result.ok) {
    const message = (result && result.error) || `adhoc ${command} failed`;
    console.error(message);
    // Parse/refusal errors (always "Usage error: ...", "missing:",
    // "unreadable:" or "no checkable criteria:") are caller mistakes (2);
    // relay/runtime failures are 1.
    return /usage error|missing:|unreadable:|no checkable criteria/i.test(message) ? 2 : 1;
  }
  return 0;
}

function main(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }
  if (command === 'setup') return runScript('scripts/setup.mjs', ['--wizard', ...rest]);
  if (command === 'config') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      usage();
      return 0;
    }
    if (rest[0] === 'show') {
      return runScript('scripts/config-show.mjs', rest.slice(1));
    }
    if (rest[0] === 'fill') {
      return runScript('scripts/config-fill.mjs', rest.slice(1));
    }
    return runScript('scripts/setup.mjs', ['--edit', ...rest]);
  }
  if (command === 'commands') return runScript('scripts/agent-command-registry.mjs', ['install', ...rest]);
  if (command === 'adapter') return runScript('scripts/adapter-cli.mjs', rest);
  // Mission-control commands (F2): operator-only state interventions. They are
  // dispatched exactly like every other command — same subprocess, same
  // inherited stdio, same exit-code handling — so `ap cancel "why"`, `ap stop`
  // and `ap reset` behave identically whether typed directly or through a shim.
  // (`stop` and `cancel` route through the runtime-mode router first so WSL2
  // missions are stopped where they run; see missionControlRoute below.
  // `cancel` stops a live run itself before ending the mission — one prompt
  // covers the kill and the cancel.)
  if (command === 'cancel') return cancelRoute(rest);
  if (command === 'uninstall') return uninstallRoute(rest);
  if (command === 'stop') return stopCommand(rest);
  if (command === 'reset') return runScript('scripts/autopilot.mjs', ['reset', ...rest]);
  if (command === 'rebase') return runScript('scripts/autopilot.mjs', ['rebase', ...rest]);
  if (command === 'finding') return runScript('scripts/autopilot.mjs', ['finding', ...rest]);
  if (command === 'run') return runCommand(rest);
  if (command === 'plan-review' || command === 'code-review' || command === 'verify-file') return adhocRoute(command, rest);
  console.error(`Unknown command: ${command}`);
  usage();
  return 2;
}

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then(
    code => { process.exitCode = code; },
    error => {
      console.error(`ERROR: ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {main, runDetached};
