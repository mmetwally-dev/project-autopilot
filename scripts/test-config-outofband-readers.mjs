#!/usr/bin/env node
// Test that the four out-of-band config readers correctly route through the
// adapter so a saved v4 file is not misread.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAndMigrateConfig } from './config-migration.mjs';
import { toRuntimeConfig } from './config-layout.mjs';
import { runAdhocCommand } from './adhoc-runner.mjs';
import { routeSubcommand } from './runtime-mode-router.mjs';
import { renderWatchReport } from './run-history.mjs';

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ''}`);
  failed += 1;
}

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-outofband-'));
tempDirs.add(tmp);
const autopilotDir = path.join(tmp, '.autopilot');
fs.mkdirSync(autopilotDir, { recursive: true });
const configFile = path.join(autopilotDir, 'config.json');
const repoRoot = tmp;

// --- Write a v4 config with known test values ---
const v4 = {
  $schema: './config.schema.json',
  schema_version: '4.0',
  project: { repo: '.', planning_framework: 'standalone' },
  roles: {
    planner: { cli: 'test-claude', model: 'opus', reasoning: 'high', variant: '', resume_session: true, fallbacks: [] },
    plan_reviewer: { cli: 'test-codex', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    implementer: { cli: 'test-claude', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    code_reviewer: { cli: 'test-codex', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    verifier: { cli: 'test-claude', model: '', reasoning: '', variant: '', resume_session: true, fallbacks: [] },
    free_models: { auto_fallback: true, max_turns: 10 },
  },
  caps: {
    task_size_target_turns: 12,
    planner: { max_turns: 30, max_tokens: 200000, extra_sessions: 2, wrap_up_at_tokens: 180000 },
    plan_reviewer: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    implementer: { max_turns: 40, max_tokens: 180000, extra_sessions: 5, wrap_up_at_tokens: 160000 },
    code_reviewer: { max_turns: 22, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    verifier: { max_turns: 30, max_tokens: 150000, extra_sessions: 2, wrap_up_at_tokens: 135000 },
    mission_token_backstop: 6000000,
  },
  retries: { plan_revisions: 8, implementation: 4, verification: 4, final_review_fix_rounds: 2, cli_errors: 3, infrastructure: 3, no_progress_sessions: 2, extra_sessions_per_task: 5 },
  time_limits: { call_backstop_minutes: 160, silent_run_minutes: 10 },
  workflow: { plan_review: true, commit_by_human: true },
  tests: { gate_commands: ['echo test'], gate_network: true, require_reviewer: true },
  safety: { allow_git_commit: false, stop_on_sandbox_violation: true },
  runtime: { mode: 'linux-strong', wsl_distro: null },
  frameworks: {},
  advanced: { state_file: '.autopilot/state.json', runs_dir: '.autopilot/runs', handoff_max_chars: 2000 },
};

fs.writeFileSync(configFile, JSON.stringify(v4, null, 2) + '\n');

// Also create a minimal state.json for renderWatchReport
fs.writeFileSync(path.join(autopilotDir, 'state.json'), JSON.stringify({ phase: 'planning' }, null, 2) + '\n');

// Create a dummy plan file for plan-review
const planFile = path.join(tmp, 'plan.md');
fs.writeFileSync(planFile, '# Test Plan\n\n- Step 1\n- Step 2\n');

// --- 1. adhoc-runner.mjs: defaultLoadConfig -> roles.<r>.cli ---
// Call runAdhocCommand without injected config/loadConfig, using a stubbed entry
// that captures the config passed to it.
let capturedAdhocConfig = null;
async function testAdhocRunner() {
  const mockEntry = async ({ role, prompt, adhocDir, repoRoot, config, timeoutMs }) => {
    capturedAdhocConfig = config;
    return { nestedRunDir: path.join(adhocDir, '01-plan_reviewer-abc12345'), verdict: 'PASS', findings: [] };
  };
  // We expect this to fail at the relay step (since we're not actually running anything),
  // but the config should be loaded before that.
  const result = await runAdhocCommand('plan-review', [planFile], { entry: mockEntry, repoRoot: tmp });
  // The mock entry should have been called with the config
  check('adhoc-runner: runAdhocCommand calls entry with config', !!capturedAdhocConfig);
  check('adhoc-runner: roles.planner.adapter mapped from cli', capturedAdhocConfig?.roles?.planner?.adapter === 'test-claude');
  check('adhoc-runner: roles.plan_reviewer.adapter mapped from cli', capturedAdhocConfig?.roles?.plan_reviewer?.adapter === 'test-codex');
  check('adhoc-runner: roles.implementer.adapter mapped from cli', capturedAdhocConfig?.roles?.implementer?.adapter === 'test-claude');
  check('adhoc-runner: roles.code_reviewer.adapter mapped from cli', capturedAdhocConfig?.roles?.code_reviewer?.adapter === 'test-codex');
  check('adhoc-runner: roles.verifier.adapter mapped from cli', capturedAdhocConfig?.roles?.verifier?.adapter === 'test-claude');
}

await testAdhocRunner();

// --- 2. doctor.mjs: reads gates.network_isolation ---
// Spawn doctor.mjs as a subprocess with --repo <tmp> and gate_network:true
// Should output "gates.network_isolation=false — commands will run without network isolation"
function testDoctor() {
  const doctorPath = path.resolve('./scripts/doctor.mjs');
  const result = spawnSync('node', [doctorPath, '--repo', tmp], { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout + result.stderr;
  // With gate_network: true in v4 config, network_isolation should be false
  check('doctor: spawned successfully', result.status === 0);
  check('doctor: reports network_isolation=false', output.includes('gates.network_isolation=false'));
  check('doctor: does not report network_isolation=true as required', !output.includes('gates.network_isolation is true (required)'));
}

testDoctor();

// --- 3. runtime-mode-router.mjs: reads runtime.mode -> execution.runtime_mode ---
// Call routeSubcommand WITHOUT injecting readConfig (uses default safeReadConfig)
async function testRuntimeModeRouter() {
  const result = await routeSubcommand({
    command: 'run',
    repoArgs: ['--repo', repoRoot],
    cwd: tmp,
    skillRoot: '/tmp',
    detectCapabilities: async () => ({
      currentPlatform: 'native-linux',
      modes: [
        { id: 'wsl2-strong', available: false, strength: 'strong', supportedFrameworks: ['gsd', 'speckit', 'standalone'], reason: 'not_applicable_current_platform_is_native_linux', distro: null },
        { id: 'linux-strong', available: true, strength: 'strong', supportedFrameworks: ['gsd', 'speckit', 'standalone'], reason: null, distro: null },
        { id: 'windows-compatibility', available: false, strength: 'compatibility', supportedFrameworks: ['speckit', 'standalone'], reason: 'not_applicable_current_platform_is_native_linux', distro: null },
      ],
      recommendedMode: 'linux-strong',
      usableWslDistro: null,
    }),
  });
  check('runtime-mode-router: routeSubcommand proceeds with linux-strong', result?.action === 'proceed' && result?.mode === 'linux-strong');
}

await testRuntimeModeRouter();

// --- 4. run-history.mjs: reads policy for the header ---
// Call renderWatchReport on the temp repo (which internally calls loadAndMigrateConfig)
function testRunHistory() {
  const report = renderWatchReport(tmp, null, { tail: 5 });
  check('run-history: renderWatchReport produces output', typeof report === 'string' && report.length > 0);
  // The report should include policy info from the config
  check('run-history: report mentions policy or caps', report.includes('policy') || report.includes('caps') || report.includes('turns') || report.includes('tokens'));
}

testRunHistory();

// Also test that the raw readJsonFile (old way) would fail to read v4 correctly
const rawConfig = readJsonFile(configFile);
check('run-history: raw readJsonFile has no .policy (v4 uses caps/retries/time_limits)', rawConfig?.policy === undefined);
check('run-history: raw readJsonFile has .caps (v4 layout)', !!rawConfig?.caps);
check('run-history: raw readJsonFile has .tests.gate_network', rawConfig?.tests?.gate_network === true);

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);