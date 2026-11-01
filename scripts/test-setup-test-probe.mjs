#!/usr/bin/env node
// Backlog #4 Part A: a real setup run against a throwaway project whose test
// command fails for environment reasons must save the runner's exclusion flag
// plus tests.not_run_in_missions. A real assertion failure must NOT be
// excluded, and a passing command must save unchanged.
//
// Setup runs as a subprocess with AUTOPILOT_SETUP_FORCE_INTERACTIVE=1 and a
// fake `claude` CLI (copy of the ELF `true`) so no real agent or network is
// touched. The test commands are plain node scripts in the fixture repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const setupScript = path.join(here, "setup.mjs");

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const delimiter = process.platform === "win32" ? ";" : ":";
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const systemDirs = process.platform === "win32"
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ["/usr/bin", "/bin"];

function makeFakeCliDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-probe-fake-cli-"));
  const fakeClaude = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, "@echo off\nif \"%1\"==\"--version\" (echo claude-test & exit /b 0)\nif \"%1\"==\"--help\" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n");
  } else {
    const realTrue = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return dir;
}

// Minimal valid v4 config: one fake `claude` for every role, no model
// selection (so validation never asks for live verification).
function baseConfig() {
  const one = () => ({
    adapter: "claude",
    model: "",
    reasoning: "",
    variant: "",
    resume: true,
    model_source: "default",
    model_verified_at: null,
    capabilities_verified_at: null
  });
  return {
    $schema: "./config.schema.json",
    schema_version: "4.0",
    project: {
      repo: ".",
      planning_framework: "standalone",
      state_file: ".autopilot/state.json",
      runs_dir: ".autopilot/runs"
    },
    roles: {
      planner: one(),
      plan_reviewer: one(),
      implementer: one(),
      code_reviewer: one(),
      verifier: one()
    },
    workflow: {},
    tests: {
      gate_commands: [],
      gate_network: false,
      gate_env_allowlist: [],
      not_run_in_missions: [],
      not_run_in_missions_original_command: "",
      require_reviewer: true,
      browser: "native",
      require_browser: "when-task-requires"
    },
    safety: {},
    runtime: { mode: "linux-strong", wsl_distro: null },
    frameworks: {
      speckit: {
        workflow_file: ".specify/workflows/speckit/workflow.yml",
        task_files: [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"]
      },
      gsd: { phase_root: ".planning/phases" }
    },
    advanced: {
      state_file: ".autopilot/state.json",
      runs_dir: ".autopilot/runs"
    }
  };
}

function makeRepo({ script, testScript = "node test-run.mjs" }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-probe-repo-"));
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig(), null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "probe-fixture",
    scripts: { test: testScript }
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "test-run.mjs"), script);
  return repo;
}

function runSetup({ repo, binDir, answers, timeoutMs = 30000 }) {
  const env = {
    ...process.env,
    PATH: [binDir, ...systemDirs].join(delimiter),
    AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"
  };
  const child = spawn(process.execPath, [setupScript, "--edit", "--repo", repo],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }, timeoutMs);
  const done = new Promise((resolve) => {
    child.on("error", (error) => { stdout += `\nspawn error: ${error.message}`; });
    child.on("close", (status, signal) => {
      clearTimeout(watchdog);
      resolve({ status, signal, timedOut, stdout, stderr });
    });
  });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdin.write(answers.map((answer) => `${answer}\n`).join(""));
  child.stdin.end();
  return done;
}

function readTests(repo) {
  const config = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8"));
  return config.tests ?? {};
}

async function runCase(name, fn) {
  console.log(`\n${name}:`);
  const binDir = makeFakeCliDir();
  const repos = [];
  try {
    await fn({ binDir, makeRepo: (options) => { const repo = makeRepo(options); repos.push(repo); return repo; } });
  } catch (error) {
    failed++;
    console.log(`  ✗ case threw: ${error?.stack || error}`);
  } finally {
    for (const repo of repos) {
      try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(binDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function ok(name, result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  check(`${name}: setup completed`, result.status === 0 && !result.timedOut,
    `status=${result.status} timedOut=${result.timedOut}\n${combined.slice(-2000)}`);
  return combined;
}

const VITEST_ENV_OUTPUT = [
  " FAIL  tests/integration/server.test.ts > calls the API",
  "Error: fetch failed",
  "  cause: Error: connect ECONNREFUSED 127.0.0.1:3000",
  " ❯ tests/integration/server.test.ts (2 tests | 2 failed) 12ms",
  "   → fetch failed",
  "",
  " FAIL  tests/unit/patient-db.test.ts > loads a patient",
  "Error: Environment variable not found: DATABASE_URL",
  " ❯ tests/unit/patient-db.test.ts (1 test | 1 failed) 5ms",
  "   → Environment variable not found: DATABASE_URL",
  "",
  " Test Files  2 failed (2)"
].join("\n");

const VITEST_OTHER_OUTPUT = [
  " FAIL  tests/unit/math.test.ts > adds numbers",
  "AssertionError: expected 2 to be 3",
  " ❯ tests/unit/math.test.ts (1 test | 1 failed) 4ms",
  "   → expected 2 to be 3 // Object.is equality",
  "",
  " Test Files  1 failed (1)"
].join("\n");

const VITEST_PASS_OUTPUT = " ✓ tests/unit/math.test.ts (1 test) 4ms\n Test Files  1 passed (1)\n";

const JEST_ENV_OUTPUT = [
  "FAIL tests/db.test.js",
  "  ● Test suite failed to run",
  "",
  "    Environment variable not found: DATABASE_URL",
  "",
  "Test Suites: 1 failed, 1 total"
].join("\n");

const UNKNOWN_OUTPUT = "the custom runner exploded\n";

const vitestEnvScript = `process.stdout.write(${JSON.stringify(VITEST_ENV_OUTPUT)}); process.exit(1);\n`;
const vitestOtherScript = `process.stdout.write(${JSON.stringify(VITEST_OTHER_OUTPUT)}); process.exit(1);\n`;
const vitestPassScript = `process.stdout.write(${JSON.stringify(VITEST_PASS_OUTPUT)}); process.exit(0);\n`;
const jestEnvScript = `process.stdout.write(${JSON.stringify(JEST_ENV_OUTPUT)}); process.exit(1);\n`;
const unknownScript = `process.stdout.write(${JSON.stringify(UNKNOWN_OUTPUT)}); process.exit(1);\n`;

await runCase("vitest environment failures are excluded", async ({ binDir, makeRepo }) => {
  const repo = makeRepo({ script: vitestEnvScript });
  const result = await runSetup({ repo, binDir, answers: ["3", "node test-run.mjs", "", ""] });
  const out = ok("vitest env", result);
  const tests = readTests(repo);
  checkEqual("saved vitest exclusion command", tests.gate_commands,
    ['node test-run.mjs --exclude "tests/integration/server.test.ts" --exclude "tests/unit/patient-db.test.ts"']);
  checkEqual("original command recorded", tests.not_run_in_missions_original_command, "node test-run.mjs");
  const list = tests.not_run_in_missions ?? [];
  checkEqual("two not-run groups", list.map((entry) => entry.reason), [
    "server not reachable on 127.0.0.1:3000",
    "missing environment variable DATABASE_URL (.env not loaded)"
  ]);
  checkEqual("server group files", list[0]?.files, ["tests/integration/server.test.ts"]);
  checkEqual("server manual command", list[0]?.command, 'node test-run.mjs "tests/integration/server.test.ts"');
  checkEqual("env group files", list[1]?.files, ["tests/unit/patient-db.test.ts"]);
  check("output shows the server reason", out.includes("server not reachable on 127.0.0.1:3000"), out.slice(-2500));
  check("output shows the env reason", out.includes("missing environment variable DATABASE_URL"), out.slice(-2500));
  check("output shows the saved gate command", out.includes('--exclude "tests/integration/server.test.ts"'), out.slice(-2500));
});

await runCase("jest environment failures use --testPathIgnorePatterns", async ({ binDir, makeRepo }) => {
  const repo = makeRepo({ script: jestEnvScript });
  const result = await runSetup({ repo, binDir, answers: ["3", "node test-run.mjs", "", ""] });
  const out = ok("jest env", result);
  const tests = readTests(repo);
  checkEqual("saved jest exclusion command", tests.gate_commands,
    ['node test-run.mjs --testPathIgnorePatterns "tests/db\\.test\\.js"']);
  checkEqual("original command recorded", tests.not_run_in_missions_original_command, "node test-run.mjs");
  checkEqual("one jest group", tests.not_run_in_missions?.length, 1);
  checkEqual("jest files", tests.not_run_in_missions?.[0]?.files, ["tests/db.test.js"]);
  check("output shows the env reason", out.includes("DATABASE_URL"), out.slice(-2500));
});

await runCase("a real test failure is not excluded", async ({ binDir, makeRepo }) => {
  const repo = makeRepo({ script: vitestOtherScript });
  const result = await runSetup({ repo, binDir, answers: ["3", "node test-run.mjs", ""] });
  const out = ok("other failure", result);
  const tests = readTests(repo);
  checkEqual("gate command unchanged", tests.gate_commands, ["node test-run.mjs"]);
  checkEqual("nothing on the not-run list", tests.not_run_in_missions ?? [], []);
  checkEqual("no original command", tests.not_run_in_missions_original_command ?? "", "");
  check("output warns the gate will keep failing", out.includes("NOT excluded") && out.includes("gate will keep failing"), out.slice(-2500));
});

await runCase("a passing command is saved unchanged", async ({ binDir, makeRepo }) => {
  const repo = makeRepo({ script: vitestPassScript });
  const result = await runSetup({ repo, binDir, answers: ["3", "node test-run.mjs", ""] });
  const out = ok("passing", result);
  const tests = readTests(repo);
  checkEqual("gate command unchanged", tests.gate_commands, ["node test-run.mjs"]);
  checkEqual("nothing on the not-run list", tests.not_run_in_missions ?? [], []);
  check("output says it passed", out.includes("Test command passed"), out.slice(-2500));
});

await runCase("unknown runner keeps today's behaviour with a warning", async ({ binDir, makeRepo }) => {
  const repo = makeRepo({ script: unknownScript });
  const result = await runSetup({ repo, binDir, answers: ["3", "node test-run.mjs", ""] });
  const out = ok("unknown", result);
  const tests = readTests(repo);
  checkEqual("gate command unchanged", tests.gate_commands, ["node test-run.mjs"]);
  checkEqual("nothing on the not-run list", tests.not_run_in_missions ?? [], []);
  check("output says the runner was not recognised", out.includes("could not be recognised"), out.slice(-2500));
  check("output shows the tail", out.includes("the custom runner exploded"), out.slice(-2500));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ALL CHECKS PASSED");
