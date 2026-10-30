#!/usr/bin/env node
// Mission 096 Phase 4 task 4.2: ap config / setup --edit edits the new v4 names
// and writes only the v4 layout. Drives an edit save on a temp config and
// asserts the new names are written and no legacy name remains.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
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

function findExecutable(name) {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

const toolchain = process.platform === 'linux' && process.arch === 'x64' && process.env.AP_TEST_NO_ELF !== '1'
  ? {as: findExecutable('as'), ld: findExecutable('ld')}
  : {as: null, ld: null};
const nativeFakes = Boolean(toolchain.as && toolchain.ld);

const SKIP_LINE = 'SKIP: opus/high/opencode preservation checks need as+ld on linux x64 (fake native CLIs); running the remaining checks with the simple fixture';

function fakeAssembly(flavor) {
  const help = flavor === 'opencode' ? '--model --variant --session' : '--model --effort --resume';
  const models = flavor === 'opencode' ? 'opencode/mimo-v2.6-flash-free' : 'claude';
  return [
    '.section .data',
    'version_msg:',
    '    .ascii "1.0.0\\n"',
    'version_len = . - version_msg',
    'help_msg:',
    `    .ascii "${help}\\n"`,
    'help_len = . - help_msg',
    'models_msg:',
    `    .ascii "${models}\\n"`,
    'models_len = . - models_msg',
    '',
    '.section .text',
    '.global _start',
    '_start:',
    '    mov (%rsp), %rax',
    '    cmp $2, %rax',
    '    jb help',
    '    mov 16(%rsp), %rsi',
    '    movzbl (%rsi), %eax',
    '    cmp $109, %al',
    '    je models',
    '    cmp $114, %al',
    '    je help',
    '    cmp $45, %al',
    '    jne help',
    '    movzbl 2(%rsi), %eax',
    '    cmp $118, %al',
    '    je version',
    '    jmp help',
    'version:',
    '    lea version_msg(%rip), %rsi',
    '    mov $version_len, %rdx',
    '    jmp write',
    'models:',
    '    lea models_msg(%rip), %rsi',
    '    mov $models_len, %rdx',
    '    jmp write',
    'help:',
    '    lea help_msg(%rip), %rsi',
    '    mov $help_len, %rdx',
    'write:',
    '    mov $1, %rax',
    '    mov $1, %rdi',
    '    syscall',
    '    mov $60, %rax',
    '    xor %rdi, %rdi',
    '    syscall',
    ''
  ].join('\n');
}

function buildNativeFake(binDir, name, flavor) {
  const source = path.join(binDir, `${name}.s`);
  const object = path.join(binDir, `${name}.o`);
  const target = path.join(binDir, name);
  fs.writeFileSync(source, fakeAssembly(flavor));
  execFileSync(toolchain.as, ['--64', '-o', object, source], {stdio: 'pipe'});
  execFileSync(toolchain.ld, ['-o', target, object], {stdio: 'pipe'});
  fs.chmodSync(target, 0o755);
  fs.rmSync(source, {force: true});
  fs.rmSync(object, {force: true});
}

function makeFakeCliDir() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-edit-names-fake-cli-'));
  tempDirs.add(binDir);
  if (nativeFakes) {
    buildNativeFake(binDir, 'claude', 'claude');
    buildNativeFake(binDir, 'opencode', 'opencode');
  } else {
    const fakeClaude = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (process.platform === 'win32') {
      fs.writeFileSync(fakeClaude, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
    } else {
      const realTrue = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
      fs.copyFileSync(realTrue, fakeClaude);
      fs.chmodSync(fakeClaude, 0o755);
    }
  }
  return binDir;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-edit-names-repo-'));
  tempDirs.add(repo);
  return repo;
}

function writeV4Config(repo, config) {
  const configDir = path.join(repo, '.autopilot');
  fs.mkdirSync(configDir, {recursive: true});
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

function runApRun({repo, binDir}) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: '1'};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'autopilot.mjs'), 'run', '--stage', 'implement', '--repo', repo], {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
    child.on('close', status => { clearTimeout(watchdog); resolve({status, out}); });
    child.stdin.end();
  });
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
  if (!nativeFakes) console.log(SKIP_LINE);
  let binDir = null;
  let repo = null;

  try {
    try {
      binDir = makeFakeCliDir();
    } catch (error) {
      check(`fake native CLI build failed: ${error instanceof Error ? error.message : String(error)}`, false);
      process.exitCode = 1;
      return;
    }
    repo = makeRepo();

    // Create a v4 config with some non-default values to verify they're preserved
    const initialConfig = {
      $schema: schemaReferenceFor(path.join(repo, '.autopilot', 'config.json')),
      schema_version: "4.0",
      project: {repo: ".", planning_framework: "gsd"},
      roles: {
        planner: {cli: "claude", model: nativeFakes ? "opus" : "", reasoning: nativeFakes ? "high" : "", variant: "", resume_session: true},
        plan_reviewer: {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        implementer: nativeFakes
          ? {cli: "opencode", model: "opencode/mimo-v2.6-flash-free", reasoning: "", variant: "", resume_session: true}
          : {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        code_reviewer: {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        verifier: {cli: "claude", model: "", reasoning: "", variant: "", resume_session: true},
        free_models: {auto_fallback: false, max_turns: 30}
      },
      caps: {
        task_size_target_turns: 25,
        planner: {max_turns: 40, max_tokens: 200000, extra_sessions: 3, wrap_up_at_tokens: 180000},
        plan_reviewer: {max_turns: 30, max_tokens: 150000, extra_sessions: 4, wrap_up_at_tokens: 130000},
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
        pause_for_plan_approval: false,
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

    // Run setup --edit with scope "All configuration", then keep every saved
    // value (Enter selects the current/default option). Each role asks for its
    // CLI, model, reasoning and fallback list when the fake CLI advertises
    // model/effort flags; the simple fixture (a `true` copy) advertises none,
    // so it only asks for the CLI plus the fallback list.
    const rolePromptCount = (nativeFakes || process.platform === 'win32') ? 4 : 2;
    const stdinInput = [
      '1',  // Configuration scope: All configuration
      ''    // Planning framework: Enter keeps the saved GSD (not yet reviewed)
    ];
    for (let role = 0; role < 5; role++) {
      for (let prompt = 0; prompt < rolePromptCount; prompt++) stdinInput.push('');
    }
    stdinInput.push(
      '',   // Stronger model when stuck: No (off)
      '',   // Test command: Enter keeps the saved command
      'y'   // Save anyway if a model could not be live-verified
    );

    const r = await runSetupEdit({repo, binDir, stdinInput});
    check('setup --edit exits 0', r.status === 0, `status=${r.status}\n${r.out.slice(-3000)}`);
    if (r.status !== 0) {
      console.error(r.out.slice(-5000));
      process.exit(1);
    }

    // Start screen (backlog #4), shared by --wizard and --edit.
    check('edit start screen lists Standalone first', /Framework availability:\n✓ Standalone: built in — Autopilot writes the plan itself/.test(r.out), r.out.slice(0, 2000));
    check('edit start screen has its own Browser checks (Playwright) section', r.out.includes("\nBrowser checks (Playwright):\n✓ Playwright module:") || r.out.includes("\nBrowser checks (Playwright):\n· Playwright module:"), r.out.slice(0, 2500));
    const editFrameworkSlice = r.out.slice(r.out.indexOf("Framework availability:"), r.out.indexOf("Browser checks (Playwright):"));
    check('edit Playwright lines are not under Framework availability', !/Playwright module/.test(editFrameworkSlice), editFrameworkSlice);
    check('edit start screen uses the plain reviewer line', /[✓·✗] Reviewers (can run|will work|cannot run)/.test(r.out), r.out.slice(0, 2500));
    check('edit start screen does not use the old reviewer wording', !r.out.includes("Current reviewer mode:") && !r.out.includes("filesystem containment available"), r.out.slice(0, 2500));
    check('edit shows the saved GSD framework as current and not yet reviewed', r.out.includes("GSD — current value (not yet reviewed)") && r.out.includes("✓ planning: gsd (not yet reviewed)"), r.out.slice(0, 3000));

    const run = await runApRun({repo, binDir});
    const warning = '⚠ GSD is not yet reviewed in this version; Standalone and SpecKit are the supported frameworks.';
    check('a run with a saved GSD config prints the GSD warning exactly once', (run.out.split(warning).length - 1) === 1, `status=${run.status}\n${run.out.slice(0, 3000)}`);
    check('the GSD warning does not block the run before the stage guard', run.out.includes(warning), run.out.slice(0, 3000));

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
    check('roles.planner.model preserved', config.roles.planner.model === (nativeFakes ? 'opus' : ''));
    check('roles.planner.reasoning preserved', config.roles.planner.reasoning === (nativeFakes ? 'high' : ''));
    check('roles.implementer.cli preserved', config.roles.implementer.cli === (nativeFakes ? 'opencode' : 'claude'));
    check('roles.implementer.model preserved', config.roles.implementer.model === (nativeFakes ? 'opencode/mimo-v2.6-flash-free' : ''));
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
    if (binDir) try { fs.rmSync(binDir, {recursive: true, force: true}); } catch { }
    if (repo) try { fs.rmSync(repo, {recursive: true, force: true}); } catch { }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});