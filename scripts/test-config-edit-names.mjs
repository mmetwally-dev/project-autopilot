#!/usr/bin/env node
// Mission 096 Phase 4 task 4.2: ap config / setup --edit edits the new v4 names
// and writes only the v4 layout. Drives an edit save on a temp config and
// asserts the new names are written and no legacy name remains.

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
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-edit-names-fake-cli-'));
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-edit-names-repo-'));
}

function writeV4Config(repo, config) {
  const configDir = path.join(repo, '.autopilot');
  fs.mkdirSync(configDir, {recursive: true});
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

function runSetupEdit({repo, binDir, stdinInput}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupScript, '--edit', '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
    child.on('close', status => { clearTimeout(watchdog); resolve({status, out}); });
    child.stdin.write(stdinInput.map(a => `${a}\n`).join(''));
    child.stdin.end();
  });
}

async function main() {
  const binDir = makeFakeCliDir();
  const repo = makeRepo();

  try {
    // Create a v4 config with some non-default values to verify they're preserved
    const initialConfig = {
      $schema: schemaReferenceFor(path.join(repo, '.autopilot', 'config.json')),
      schema_version: "4.0",
      project: {repo: ".", planning_framework: "gsd"},
      roles: {
        planner: {cli: "claude", model: "opus", reasoning: "high", variant: "", resume_session: true},
        plan_reviewer: {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        implementer: {cli: "opencode", model: "", reasoning: "", variant: "", resume_session: true},
        code_reviewer: {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        verifier: {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        free_models: {auto_fallback: false, max_turns: 30}
      },
      caps: {
        task_size_target_turns: 25,
        planner: {max_turns: 40, max_tokens: 200000, extra_sessions: 3, wrap_up_at_tokens: 180000},
        plan_reviewer: {max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 130000},
        implementer: {max_turns: 50, max_tokens: 250000, extra_sessions: 8, wrap_up_at_tokens: 200000},
        code_reviewer: {max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 130000},
        verifier: {max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 130000},
        mission_token_backstop: 5000000
      },
      retries: {
        plan_revisions: 10,
        implementation: 5,
        verification: 5,
        final_review_fix_rounds: 3,
        cli_errors: 2,
        infrastructure: 2,
        no_progress_sessions: 3,
        extra_sessions_per_task: 6
      },
      time_limits: {
        role_timeout_minutes: {default: 40, verifier: 200},
        call_backstop_minutes: 60,
        role_timeout_floor_minutes: 10,
        silent_run_minutes: 15,
        no_first_output_minutes: 5,
        read_only_max_silence_minutes: 20,
        retry_wait_seconds: 90
      },
      workflow: {
        plan_review: true,
        plan_review_rounds_converge: false,
        gsd_planning_review: true,
        spec_review: true,
        code_review_per_phase: true,
        final_review: true,
        analysis_after_tasks: true,
        approve_spec_myself: false,
        approve_plan_myself: false,
        parallel_independent_tasks: false,
        use_worktrees: true,
        commit_by_human: true
      },
      tests: {
        gate_commands: ["npm test"],
        gate_network: true,
        gate_env_allowlist: ["PATH", "HOME"],
        require_reviewer: true,
        browser: "native",
        require_browser: "when-task-requires",
        verify_denylist: ["scripts/test-slow.mjs"]
      },
      safety: {
        allow_git_commit: false,
        allow_git_push: false,
        allow_destructive_operations: false,
        stop_on_sandbox_violation: true,
        block_git_in_roles: true,
        check_read_only_roles: true,
        record_touched_files: true,
        keep_role_sessions: true
      },
      runtime: {mode: "linux-strong", wsl_distro: null},
      frameworks: {
        speckit: {workflow_file: ".specify/workflows/speckit/workflow.yml", task_files: [".specify/tasks.md"]},
        gsd: {phase_root: ".planning/phases", run_plan_verify: true, run_state_validate: true, write_summary_artifacts: true, write_verification_artifacts: true, write_uat_artifact: true, use_gsd_tools_when_available: true, planning_review: {enabled: true, review_after_each_stage: true, stages: ["discuss", "research", "plan", "plan-check"], max_revisions: 3, read_only_reviewer: true}, parallel: {enabled: false, plan_level: false, task_level: false, max_concurrent_agents: 3, min_plans_for_parallel: 2}}
      },
      advanced: {
        state_file: ".autopilot/state.json",
        runs_dir: ".autopilot/runs",
        handoff_max_chars: 2000,
        handoff_note_max_chars: 4000,
        handoff_wrapup_tokens: 160000,
        fallback_retry_primary_minutes: 60,
        checkpoint_after_task: true,
        checkpoint_after_phase: true,
        capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false}
      }
    };

    writeV4Config(repo, initialConfig);

    // Run setup --edit with scope "All configuration" (option 1), then for each role choose "Keep current" (option 1)
    // Menu flow:
    // 1. Configuration scope: "All configuration" (option 1)
    // 2. Planning framework: "GSD" (option 2) - keep current
    // 3. For each of 5 roles: "Claude" (option 1) - keep current
    // 4. Gate test command: accept detected (empty)
    // 5. Runtime mode: keep current (option 1)
    // 6. Network isolation: keep current (n for "Allow without isolation?")
    // 7. Escalation models: "Skip (off)" for planner and code_reviewer (option 1 each)
    // 8. Save confirmation: "y"
    const stdinInput = [
      '1',  // Configuration scope: All configuration
      '2',  // Planning framework: GSD (keep current)
      // Role 1: planner
      '1',  // CLI: claude (keep current)
      '',   // Model: keep current (opus)
      '1',  // Reasoning: high (keep current)
      '',   // Variant: keep current
      // Role 2: plan_reviewer
      '1',  // CLI: claude (keep current)
      '',   // Model: keep current
      '',   // Reasoning: keep current
      '',   // Variant: keep current
      // Role 3: implementer
      '1',  // CLI: claude (but current is opencode - wait, available only has claude)
      '',   // Model: keep current
      '',   // Reasoning: keep current
      '',   // Variant: keep current
      // Role 4: code_reviewer
      '1',  // CLI: claude (keep current)
      '',   // Model: keep current
      '',   // Reasoning: keep current
      '',   // Variant: keep current
      // Role 5: verifier
      '1',  // CLI: claude (keep current)
      '',   // Model: keep current
      '',   // Reasoning: keep current
      '',   // Variant: keep current
      '',   // Gate test command: accept detected
      '1',  // Runtime mode: keep current
      'n',  // Network isolation: keep current (don't allow without)
      '1',  // Escalation for planner: Skip (off)
      '1',  // Escalation for code_reviewer: Skip (off)
      'y'   // Save confirmation
    ];

    const r = await runSetupEdit({repo, binDir, stdinInput});
    check('setup --edit exits 0', r.status === 0, `status=${r.status}\n${r.out.slice(-3000)}`);
    if (r.status !== 0) {
      console.error(r.out.slice(-5000));
      process.exit(1);
    }

    const configPath = path.join(repo, '.autopilot', 'config.json');
    check('config.json exists', fs.existsSync(configPath), configPath);

    const raw = fs.readFileSync(configPath, 'utf8');
    check('file ends with newline', raw.endsWith('\n'));
    check('file has $schema as first key', /^\{\s*"\$schema"/.test(raw), `first 100 chars: ${raw.slice(0, 100)}`);

    const config = JSON.parse(raw);

    // Top-level structure - v4 sections present
    check('$schema resolves from .autopilot/', config.$schema === schemaReferenceFor(configPath) && schemaReferenceResolves(config.$schema, path.dirname(configPath)), config.$schema);
    check('has schema_version 4.0', config.schema_version === '4.0');

    const v4Sections = ['project', 'roles', 'caps', 'retries', 'time_limits', 'workflow', 'tests', 'safety', 'runtime', 'frameworks', 'advanced'];
    for (const section of v4Sections) {
      check(`has section "${section}"`, section in config, `missing ${section}`);
    }

    // No legacy sections in the saved file
    const legacySections = ['policy', 'gates', 'execution', 'planning', 'capabilities', 'freeModelAutoFallback', 'config_metadata'];
    for (const section of legacySections) {
      check(`no legacy section "${section}"`, !(section in config), `legacy section ${section} should not be in v4 file`);
    }

    // Roles use "cli" not "adapter"
    const roleNames = ['planner', 'plan_reviewer', 'implementer', 'code_reviewer', 'verifier'];
    for (const role of roleNames) {
      check(`roles.${role} has cli`, 'cli' in config.roles[role], `roles.${role}.cli missing`);
      check(`roles.${role} has no adapter`, !('adapter' in config.roles[role]), `roles.${role}.adapter should not exist`);
      check(`roles.${role} has resume_session`, 'resume_session' in config.roles[role], `roles.${role}.resume_session missing`);
      check(`roles.${role} has no resume`, !('resume' in config.roles[role]), `roles.${role}.resume should not exist`);
    }

    // caps section uses new names
    check('caps.planner.max_turns exists', 'max_turns' in config.caps.planner);
    check('caps.planner.max_tokens exists', 'max_tokens' in config.caps.planner);
    check('caps.planner.extra_sessions exists', 'extra_sessions' in config.caps.planner);
    check('caps.planner.wrap_up_at_tokens exists', 'wrap_up_at_tokens' in config.caps.planner);
    check('caps.implementer.max_turns exists', 'max_turns' in config.caps.implementer);
    check('caps.implementer.max_tokens exists', 'max_tokens' in config.caps.implementer);
    check('caps.implementer.extra_sessions exists', 'extra_sessions' in config.caps.implementer);
    check('caps.implementer.wrap_up_at_tokens exists', 'wrap_up_at_tokens' in config.caps.implementer);
    check('caps.task_size_target_turns exists', 'task_size_target_turns' in config.caps);
    check('caps.mission_token_backstop exists', 'mission_token_backstop' in config.caps);

    // retries section uses new names
    check('retries.plan_revisions exists', 'plan_revisions' in config.retries);
    check('retries.implementation exists', 'implementation' in config.retries);
    check('retries.verification exists', 'verification' in config.retries);
    check('retries.final_review_fix_rounds exists', 'final_review_fix_rounds' in config.retries);
    check('retries.cli_errors exists', 'cli_errors' in config.retries);
    check('retries.infrastructure exists', 'infrastructure' in config.retries);
    check('retries.no_progress_sessions exists', 'no_progress_sessions' in config.retries);
    check('retries.extra_sessions_per_task exists', 'extra_sessions_per_task' in config.retries);

    // time_limits section uses minutes
    check('time_limits.role_timeout_minutes.default exists', config.time_limits.role_timeout_minutes?.default !== undefined);
    check('time_limits.call_backstop_minutes exists', 'call_backstop_minutes' in config.time_limits);
    check('time_limits.silent_run_minutes exists', 'silent_run_minutes' in config.time_limits);
    check('time_limits.no_first_output_minutes exists', 'no_first_output_minutes' in config.time_limits);
    check('time_limits.read_only_max_silence_minutes exists', 'read_only_max_silence_minutes' in config.time_limits);
    check('time_limits.retry_wait_seconds exists', 'retry_wait_seconds' in config.time_limits);

    // safety section uses new names
    check('safety.allow_git_commit exists', 'allow_git_commit' in config.safety);
    check('safety.allow_git_push exists', 'allow_git_push' in config.safety);
    check('safety.allow_destructive_operations exists', 'allow_destructive_operations' in config.safety);
    check('safety.stop_on_sandbox_violation exists', 'stop_on_sandbox_violation' in config.safety);
    check('safety.block_git_in_roles exists', 'block_git_in_roles' in config.safety);
    check('safety.check_read_only_roles exists', 'check_read_only_roles' in config.safety);
    check('safety.record_touched_files exists', 'record_touched_files' in config.safety);
    check('safety.keep_role_sessions exists', 'keep_role_sessions' in config.safety);

    // Verify some non-default values were preserved
    check('roles.planner.cli preserved', config.roles.planner.cli === 'claude');
    check('roles.planner.model preserved', config.roles.planner.model === 'opus');
    check('roles.planner.reasoning preserved', config.roles.planner.reasoning === 'high');
    check('roles.implementer.cli preserved', config.roles.implementer.cli === 'opencode');
    check('roles.free_models.auto_fallback preserved', config.roles.free_models.auto_fallback === false);
    check('roles.free_models.max_turns preserved', config.roles.free_models.max_turns === 30);
    check('caps.planner.max_turns preserved', config.caps.planner.max_turns === 40);
    check('caps.task_size_target_turns preserved', config.caps.task_size_target_turns === 25);
    check('retries.plan_revisions preserved', config.retries.plan_revisions === 10);
    check('time_limits.call_backstop_minutes preserved', config.time_limits.call_backstop_minutes === 60);
    check('time_limits.role_timeout_minutes.default preserved', config.time_limits.role_timeout_minutes.default === 40);
    check('safety.stop_on_sandbox_violation preserved', config.safety.stop_on_sandbox_violation === true);

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