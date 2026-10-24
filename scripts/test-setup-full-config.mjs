#!/usr/bin/env node
// Mission 096 Phase 4 task 4.1: setup writes the full v4 layout with all
// sections/keys at their defaults, "$schema" first, schema_version "4.0".
// Runs setup --wizard in a temp repo with a fake CLI on PATH and asserts
// the saved file has the complete v4 structure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {delimiter} from 'node:path';
import {schemaReferenceFor, schemaReferenceResolves} from './config-schema-ref.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const setupScript = path.join(here, 'setup.mjs');

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemDirs = process.platform === 'win32'
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ['/usr/bin', '/bin'];

function makeFakeCliDir() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-full-config-fake-cli-'));
  tempDirs.add(binDir);
  const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeClaude, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
  } else {
    const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return binDir;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-full-config-repo-'));
  tempDirs.add(repo);
  return repo;
}

function runSetupWizard({repo, binDir}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupScript, '--wizard', '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
    child.on('close', status => { clearTimeout(watchdog); resolve({status, out}); });
    // Wizard answers: continue, (adapter, fallback) x 5, framework, gates
    // All defaults: '' for continue, '1' for adapter (claude), '1' for fallback (No), '1' for framework (standalone), '' for gates (accept detected)
    child.stdin.write(['', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1', ''].map(a => `${a}\n`).join(''));
    child.stdin.end();
  });
}

async function main() {
  const binDir = makeFakeCliDir();
  const repo = makeRepo();
  // Backlog #4: a .planning/ repo must show GSD as found but never offer it.
  fs.mkdirSync(path.join(repo, '.planning'), {recursive: true});
  fs.writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  fs.writeFileSync(path.join(repo, '.planning', 'STATE.md'), '# State\n');

  try {
    const r = await runSetupWizard({repo, binDir});
    check('setup --wizard exits 0', r.status === 0, `status=${r.status}\n${r.out.slice(-2000)}`);
    if (r.status !== 0) {
      console.error(r.out.slice(-3000));
      process.exit(1);
    }

    // Start screen (backlog #4), shared by --wizard and --edit.
    check('wizard start screen lists Standalone first', /Framework availability:\n✓ Standalone: built in — Autopilot writes the plan itself/.test(r.out), r.out.slice(0, 2000));
    check('wizard start screen has its own Browser checks (Playwright) section', r.out.includes("\nBrowser checks (Playwright):\n✓ Playwright module:") || r.out.includes("\nBrowser checks (Playwright):\n· Playwright module:"), r.out.slice(0, 2500));
    const wizardFrameworkSlice = r.out.slice(r.out.indexOf("Framework availability:"), r.out.indexOf("Browser checks (Playwright):"));
    check('wizard Playwright lines are not under Framework availability', !/Playwright module/.test(wizardFrameworkSlice), wizardFrameworkSlice);
    check('wizard start screen uses the plain reviewer line', /[✓·✗] Reviewers (can run|will work|cannot run)/.test(r.out), r.out.slice(0, 2500));
    check('wizard start screen does not use the old reviewer wording', !r.out.includes("Current reviewer mode:") && !r.out.includes("filesystem containment available"), r.out.slice(0, 2500));
    check('a .planning/ repo shows GSD as found but not supported', r.out.includes("· GSD: found (.planning/) — support comes in a future version"), r.out.slice(0, 2000));
    check('GSD is not offered as a framework choice', !r.out.includes("GSD — use this project") && !r.out.includes("GSD — current value"), r.out.slice(0, 3000));

    const configPath = path.join(repo, '.autopilot', 'config.json');
    check('config.json exists', fs.existsSync(configPath), configPath);

    const raw = fs.readFileSync(configPath, 'utf8');
    check('file ends with newline', raw.endsWith('\n'));
    // $schema should be the first key in the JSON object (after the opening brace)
    check('file has $schema as first key', /^\{\s*"\$schema"/.test(raw), `first 100 chars: ${raw.slice(0, 100)}`);

    const config = JSON.parse(raw);

    // Top-level structure
    check('$schema resolves from .autopilot/', config.$schema === schemaReferenceFor(configPath) && schemaReferenceResolves(config.$schema, path.dirname(configPath)), config.$schema);
    check('has schema_version 4.0', config.schema_version === '4.0');

    // All v4 sections present
    const v4Sections = ['project', 'roles', 'caps', 'retries', 'time_limits', 'workflow', 'tests', 'safety', 'runtime', 'frameworks', 'advanced'];
    for (const section of v4Sections) {
      check(`has section "${section}"`, section in config, `missing ${section}`);
    }

    // No legacy sections in the saved file
    const legacySections = ['policy', 'gates', 'execution', 'planning', 'capabilities'];
    for (const section of legacySections) {
      check(`no legacy section "${section}"`, !(section in config), `legacy section ${section} should not be in v4 file`);
    }

    // No config_metadata in the saved file
    check('no config_metadata', !('config_metadata' in config));

    // project section - only repo and planning_framework at top level; state_file/runs_dir are in advanced
    check('project.repo', config.project.repo === '.');
    check('project.planning_framework', config.project.planning_framework === 'standalone');
    check('project has no state_file', !('state_file' in config.project));
    check('project has no runs_dir', !('runs_dir' in config.project));

    // roles section - all 5 roles + free_models
    const roleNames = ['planner', 'plan_reviewer', 'implementer', 'code_reviewer', 'verifier'];
    for (const role of roleNames) {
      check(`roles.${role} exists`, role in config.roles);
      check(`roles.${role}.cli`, config.roles[role].cli === 'claude');
      check(`roles.${role}.model`, config.roles[role].model === '');
      check(`roles.${role}.reasoning`, config.roles[role].reasoning === '');
      check(`roles.${role}.variant`, config.roles[role].variant === '');
      // resume_session is false because fake CLI doesn't advertise resume support
      check(`roles.${role}.resume_session`, config.roles[role].resume_session === false);
      // fallbacks key is omitted when empty (applyFallbacks behavior)
      check(`roles.${role} has no fallbacks key`, !('fallbacks' in config.roles[role]));
    }
    check('roles.free_models.auto_fallback', config.roles.free_models.auto_fallback === true);
    check('roles.free_models.max_turns', config.roles.free_models.max_turns === 45);

    // caps section - all role caps + task_size_target_turns + mission_token_backstop
    check('caps.task_size_target_turns', config.caps.task_size_target_turns === 30);
    check('caps.mission_token_backstop', config.caps.mission_token_backstop === 6000000);
    for (const role of ['planner', 'plan_reviewer', 'implementer', 'code_reviewer', 'verifier']) {
      check(`caps.${role} exists`, role in config.caps);
      check(`caps.${role}.max_turns`, typeof config.caps[role].max_turns === 'number' && config.caps[role].max_turns > 0);
      check(`caps.${role}.max_tokens`, typeof config.caps[role].max_tokens === 'number' && config.caps[role].max_tokens > 0);
      check(`caps.${role}.extra_sessions`, typeof config.caps[role].extra_sessions === 'number' && config.caps[role].extra_sessions >= 0);
      check(`caps.${role}.wrap_up_at_tokens`, typeof config.caps[role].wrap_up_at_tokens === 'number' && config.caps[role].wrap_up_at_tokens > 0);
    }
    // planner does NOT have backstop_raw_tokens at default (only set when explicitly configured)
    check('caps.planner has no backstop_raw_tokens', !('backstop_raw_tokens' in config.caps.planner));

    // retries section
    check('retries.plan_revisions', config.retries.plan_revisions === 8);
    check('retries.implementation', config.retries.implementation === 4);
    check('retries.verification', config.retries.verification === 4);
    check('retries.final_review_fix_rounds', config.retries.final_review_fix_rounds === 2);
    check('retries.cli_errors', config.retries.cli_errors === 3);
    check('retries.infrastructure', config.retries.infrastructure === 3);
    check('retries.no_progress_sessions', config.retries.no_progress_sessions === 2);
    check('retries.extra_sessions_per_task', config.retries.extra_sessions_per_task === 5);

    // time_limits section
    check('time_limits.role_timeout_minutes.default', config.time_limits.role_timeout_minutes.default === 60);
    check('time_limits.role_timeout_minutes.verifier', config.time_limits.role_timeout_minutes.verifier === 180);
    check('time_limits.call_backstop_minutes', config.time_limits.call_backstop_minutes === 200);
    check('time_limits.role_timeout_floor_minutes', config.time_limits.role_timeout_floor_minutes === null);
    check('time_limits.silent_run_minutes', config.time_limits.silent_run_minutes === 10);
    check('time_limits.no_first_output_minutes', config.time_limits.no_first_output_minutes === 3);
    check('time_limits.read_only_max_silence_minutes', config.time_limits.read_only_max_silence_minutes === 15);
    check('time_limits.retry_wait_seconds', config.time_limits.retry_wait_seconds === 60);

    // workflow section
    const workflowKeys = ['plan_review', 'plan_review_rounds_converge', 'gsd_planning_review', 'spec_review', 'code_review_per_phase', 'final_review', 'analysis_after_tasks', 'approve_spec_myself', 'approve_plan_myself', 'parallel_independent_tasks', 'use_worktrees', 'commit_by_human'];
    for (const key of workflowKeys) {
      check(`workflow.${key}`, key in config.workflow);
    }

    // tests section - gate_commands gets the detected command "1" from our test input
    check('tests.gate_commands', Array.isArray(config.tests.gate_commands));
    check('tests.gate_network', config.tests.gate_network === false);
    check('tests.gate_env_allowlist', Array.isArray(config.tests.gate_env_allowlist));
    check('tests.require_reviewer', config.tests.require_reviewer === true);
    check('tests.browser', config.tests.browser === 'native');
    check('tests.require_browser', config.tests.require_browser === 'when-task-requires');
    check('tests.verify_denylist', Array.isArray(config.tests.verify_denylist));

    // safety section
    const safetyKeys = ['allow_git_commit', 'allow_git_push', 'allow_destructive_operations', 'stop_on_sandbox_violation', 'block_git_in_roles', 'check_read_only_roles', 'record_touched_files', 'keep_role_sessions'];
    for (const key of safetyKeys) {
      check(`safety.${key}`, key in config.safety);
    }

    // runtime section - on WSL2 this will be wsl2-strong
    check('runtime.mode exists', 'mode' in config.runtime);
    check('runtime.wsl_distro', config.runtime.wsl_distro === null);

    // frameworks section
    check('frameworks.speckit', 'speckit' in config.frameworks);
    check('frameworks.gsd', 'gsd' in config.frameworks);
    check('frameworks.speckit.workflow_file', config.frameworks.speckit.workflow_file === '.specify/workflows/speckit/workflow.yml');
    check('frameworks.gsd.phase_root', config.frameworks.gsd.phase_root === '.planning/phases');

    // advanced section
    check('advanced.state_file', config.advanced.state_file === '.autopilot/state.json');
    check('advanced.runs_dir', config.advanced.runs_dir === '.autopilot/runs');
    check('advanced.handoff_max_chars', config.advanced.handoff_max_chars === 2000);
    check('advanced.handoff_note_max_chars', config.advanced.handoff_note_max_chars === 4000);
    check('advanced.handoff_wrapup_tokens', config.advanced.handoff_wrapup_tokens === 160000);
    check('advanced.fallback_retry_primary_minutes', config.advanced.fallback_retry_primary_minutes === 60);
    check('advanced.checkpoint_after_task', config.advanced.checkpoint_after_task === true);
    check('advanced.checkpoint_after_phase', config.advanced.checkpoint_after_phase === true);
    check('advanced.capabilities', 'capabilities' in config.advanced);

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    try { fs.rmSync(binDir, {recursive: true, force: true}); } catch { }
    try { fs.rmSync(repo, {recursive: true, force: true}); } catch { }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});