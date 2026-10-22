import {spawnSync} from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const skillRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const apBin = path.join(skillRoot, "bin", "ap.cjs");

function runAp(args, {cwd} = {}) {
  const result = spawnSync(process.execPath, [apBin, ...args], {
    stdio: "pipe",
    shell: false,
    cwd: cwd || process.cwd(),
    encoding: "utf8"
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertContains(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${message}\n  Expected to contain: ${needle}\n  Actual: ${haystack}`);
  }
}

function assertNotContains(haystack, needle, message) {
  if (haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${message}\n  Expected NOT to contain: ${needle}\n  Actual: ${haystack}`);
  }
}

// Create a temporary directory with a minimal config for testing
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-config-show-test-"));
const autopilotDir = path.join(tmpDir, ".autopilot");
fs.mkdirSync(autopilotDir, {recursive: true});

// Write a minimal valid config.json
const testConfig = {
  schema_version: "3.0",
  project: {
    repo: ".",
    planning_framework: "standalone",
    state_file: ".autopilot/state.json",
    runs_dir: ".autopilot/runs"
  },
  roles: {
    planner: {cli: "claude", model: "opus", reasoning: "high", resume_session: true},
    implementer: {cli: "claude", model: "sonnet", resume_session: true}
  },
  execution: {runtime_mode: "native"},
  workflow: {},
  gates: {network_isolation: true, commands: []},
  policy: {},
  capabilities: {},
  safety: {},
  planning: {}
};
fs.writeFileSync(path.join(autopilotDir, "config.json"), JSON.stringify(testConfig, null, 2));

console.log(`Test directory: ${tmpDir}`);

try {
  // Test 1: `ap config show` routes to show renderer
  console.log("\nTest 1: 'ap config show' routes to show renderer");
  {
    const result = runAp(["config", "show", "--repo", tmpDir]);
    assert(result.status === 0, `Expected exit code 0, got ${result.status}`);
    assertContains(result.stdout, "project.planning_framework", "Should show project.planning_framework");
    assertContains(result.stdout, "[from config.json]", "Should mark file values as [from config.json]");
    assertContains(result.stdout, "[default]", "Should mark default values as [default]");
    console.log("  PASS");
  }

  // Test 2: `ap config show --path project.planning_framework` filters output
  console.log("\nTest 2: 'ap config show --path project.planning_framework' filters output");
  {
    const result = runAp(["config", "show", "--repo", tmpDir, "--path", "project.planning_framework"]);
    assert(result.status === 0, `Expected exit code 0, got ${result.status}`);
    assertContains(result.stdout, 'project.planning_framework: "standalone"', "Should show planning_framework");
    assertNotContains(result.stdout, "roles.", "Should not show roles when filtered");
    console.log("  PASS");
  }

  // Test 3: Bare `ap config` routes to edit (shows the edit-specific header)
  console.log("\nTest 3: Bare 'ap config' routes to edit mode");
  {
    const result = runAp(["config", "--repo", tmpDir]);
    assertNotContains(result.stdout, "[from config.json]", "Bare config should not show config show output");
    assertNotContains(result.stdout, "[default]", "Bare config should not show config show output");
    // "reconfigure" is printed only by edit mode; the wizard prints "setup".
    assertContains(result.stdout, "Project Autopilot — reconfigure", "Bare config should enter the edit flow");
    assertNotContains(result.stdout, "Project Autopilot — setup", "Bare config must not enter the setup wizard");
    console.log("  PASS");
  }

  // Test 4: `ap config --help` shows usage including config show
  console.log("\nTest 4: 'ap config --help' shows usage");
  {
    const result = runAp(["config", "--help"]);
    assert(result.status === 0, `Expected exit code 0, got ${result.status}`);
    assertContains(result.stdout, "config show", "Help should mention config show subcommand");
    console.log("  PASS");
  }

  // Test 5: `ap config show --help` prints usage and exits 0
  console.log("\nTest 5: 'ap config show --help' prints usage");
  {
    const result = runAp(["config", "show", "--help"]);
    assert(result.status === 0, `Expected exit code 0, got ${result.status}`);
    assertContains(result.stdout, "Usage: ap config show", "Help should print the config show usage");
    assertNotContains(result.stdout, "project.planning_framework:", "Help must not load and render the config");
    console.log("  PASS");
  }

  // Test 6: `ap help` includes config show in usage
  console.log("\nTest 6: 'ap help' includes config show in usage");
  {
    const result = runAp(["help"]);
    assert(result.status === 0, `Expected exit code 0, got ${result.status}`);
    assertContains(result.stdout, "config show", "Main help should mention config show subcommand");
    console.log("  PASS");
  }

  // Test 7: `scripts/setup.mjs --show` renders the same effective config
  console.log("\nTest 7: 'setup.mjs --show' renders the effective config");
  {
    const setupBin = path.join(skillRoot, "scripts", "setup.mjs");
    const result = spawnSync(process.execPath, [setupBin, "--show", "--repo", tmpDir], {
      stdio: "pipe",
      shell: false,
      encoding: "utf8"
    });
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    assert(result.status === 0, `Expected exit code 0, got ${result.status}: ${stderr}`);
    assertContains(stdout, "project.planning_framework", "setup --show should render config keys");
    assertContains(stdout, "[from config.json]", "setup --show should mark file values");
    assertContains(stdout, "[default]", "setup --show should mark default values");
    console.log("  PASS");
  }

  console.log("\n✓ All tests passed!");
} finally {
  // Cleanup
  fs.rmSync(tmpDir, {recursive: true, force: true});
}