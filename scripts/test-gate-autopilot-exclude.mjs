#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withAutopilotExclude } from "./gate-autopilot-exclude.mjs";

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
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// -----------------------------------------------------------------------------
// (a) Unit cases for every rule
// -----------------------------------------------------------------------------

console.log("unit: vitest forms");
checkEqual("vitest bare", withAutopilotExclude("vitest"), 'vitest --exclude "**/.autopilot/**"');
checkEqual("vitest run", withAutopilotExclude("vitest run"), 'vitest run --exclude "**/.autopilot/**"');
checkEqual(
  "vitest run with existing other exclude",
  withAutopilotExclude('npx vitest run --exclude "tests/integration/**"'),
  'npx vitest run --exclude "tests/integration/**" --exclude "**/.autopilot/**"'
);
checkEqual("npx vitest", withAutopilotExclude("npx vitest"), 'npx vitest --exclude "**/.autopilot/**"');
checkEqual("npx vitest run", withAutopilotExclude("npx vitest run"), 'npx vitest run --exclude "**/.autopilot/**"');
checkEqual("pnpm vitest", withAutopilotExclude("pnpm vitest"), 'pnpm vitest --exclude "**/.autopilot/**"');
checkEqual("pnpm vitest run", withAutopilotExclude("pnpm vitest run"), 'pnpm vitest run --exclude "**/.autopilot/**"');
checkEqual("pnpm exec vitest", withAutopilotExclude("pnpm exec vitest"), 'pnpm exec vitest --exclude "**/.autopilot/**"');
checkEqual("pnpm exec vitest run", withAutopilotExclude("pnpm exec vitest run"), 'pnpm exec vitest run --exclude "**/.autopilot/**"');
checkEqual("yarn vitest", withAutopilotExclude("yarn vitest"), 'yarn vitest --exclude "**/.autopilot/**"');
checkEqual("yarn vitest run", withAutopilotExclude("yarn vitest run"), 'yarn vitest run --exclude "**/.autopilot/**"');
checkEqual("bunx vitest", withAutopilotExclude("bunx vitest"), 'bunx vitest --exclude "**/.autopilot/**"');
checkEqual("bunx vitest run", withAutopilotExclude("bunx vitest run"), 'bunx vitest run --exclude "**/.autopilot/**"');
checkEqual(
  "relative path to vitest",
  withAutopilotExclude("./node_modules/.bin/vitest run"),
  './node_modules/.bin/vitest run --exclude "**/.autopilot/**"'
);
checkEqual(
  "absolute path to vitest",
  withAutopilotExclude("/usr/local/bin/vitest run"),
  '/usr/local/bin/vitest run --exclude "**/.autopilot/**"'
);

console.log("unit: env prefixes");
checkEqual("CI=1 vitest", withAutopilotExclude("CI=1 vitest"), 'CI=1 vitest --exclude "**/.autopilot/**"');
checkEqual("NODE_ENV=test vitest run", withAutopilotExclude("NODE_ENV=test vitest run"), 'NODE_ENV=test vitest run --exclude "**/.autopilot/**"');
checkEqual("multiple env words", withAutopilotExclude("FOO=bar BAZ=1 npx vitest run"), 'FOO=bar BAZ=1 npx vitest run --exclude "**/.autopilot/**"');
checkEqual('quoted env value', withAutopilotExclude('ENV_VAR="with space" pytest'), 'ENV_VAR="with space" pytest --ignore=.autopilot');
checkEqual("env prefix with python pytest", withAutopilotExclude("A=1 B=2 python -m pytest"), "A=1 B=2 python -m pytest --ignore=.autopilot");

console.log("unit: pytest forms");
checkEqual("pytest bare", withAutopilotExclude("pytest"), "pytest --ignore=.autopilot");
checkEqual("pytest with args", withAutopilotExclude("pytest -v tests/"), "pytest -v tests/ --ignore=.autopilot");
checkEqual("python -m pytest", withAutopilotExclude("python -m pytest"), "python -m pytest --ignore=.autopilot");
checkEqual("python -m pytest with args", withAutopilotExclude("python -m pytest tests/"), "python -m pytest tests/ --ignore=.autopilot");
checkEqual("python3 -m pytest", withAutopilotExclude("python3 -m pytest"), "python3 -m pytest --ignore=.autopilot");
checkEqual("uv run pytest", withAutopilotExclude("uv run pytest"), "uv run pytest --ignore=.autopilot");
checkEqual("uv run pytest with args", withAutopilotExclude("uv run pytest -v"), "uv run pytest -v --ignore=.autopilot");
checkEqual("poetry run pytest", withAutopilotExclude("poetry run pytest"), "poetry run pytest --ignore=.autopilot");
checkEqual("poetry run pytest with args", withAutopilotExclude("poetry run pytest -s"), "poetry run pytest -s --ignore=.autopilot");
checkEqual("relative path to pytest", withAutopilotExclude(".venv/bin/pytest"), ".venv/bin/pytest --ignore=.autopilot");

console.log("unit: already-excluded");
checkEqual("vitest with --exclude glob", withAutopilotExclude('vitest run --exclude "**/.autopilot/**"'), 'vitest run --exclude "**/.autopilot/**"');
checkEqual("vitest with --exclude=glob", withAutopilotExclude('vitest run --exclude="**/.autopilot/**"'), 'vitest run --exclude="**/.autopilot/**"');
checkEqual("vitest with single-quoted exclude", withAutopilotExclude("vitest run --exclude '.autopilot'"), "vitest run --exclude '.autopilot'");
checkEqual("npx vitest with --exclude .autopilot", withAutopilotExclude("npx vitest run --exclude .autopilot"), "npx vitest run --exclude .autopilot");
checkEqual("pytest with --ignore=.autopilot", withAutopilotExclude("pytest --ignore=.autopilot"), "pytest --ignore=.autopilot");
checkEqual("pytest with --ignore .autopilot", withAutopilotExclude("pytest --ignore .autopilot"), "pytest --ignore .autopilot");
checkEqual("pytest with --ignore-glob=*.autopilot*", withAutopilotExclude("pytest --ignore-glob=*.autopilot*"), "pytest --ignore-glob=*.autopilot*");
checkEqual("pytest with -o addopts ignore", withAutopilotExclude('pytest -o addopts="--ignore=.autopilot"'), 'pytest -o addopts="--ignore=.autopilot"');

console.log("unit: chains unchanged");
checkEqual("chain &&", withAutopilotExclude("vitest run && npm test"), "vitest run && npm test");
checkEqual("chain ||", withAutopilotExclude("npm test || vitest run"), "npm test || vitest run");
checkEqual("chain ;", withAutopilotExclude("vitest run ; echo done"), "vitest run ; echo done");
checkEqual("chain |", withAutopilotExclude("vitest run | grep pass"), "vitest run | grep pass");
checkEqual("chain with env and pytest", withAutopilotExclude("CI=1 pytest && true"), "CI=1 pytest && true");

console.log("unit: anything else unchanged");
checkEqual("npm test", withAutopilotExclude("npm test"), "npm test");
checkEqual("npm run test", withAutopilotExclude("npm run test"), "npm run test");
checkEqual("pnpm test", withAutopilotExclude("pnpm test"), "pnpm test");
checkEqual("yarn test", withAutopilotExclude("yarn test"), "yarn test");
checkEqual("bun test", withAutopilotExclude("bun test"), "bun test");
checkEqual("jest bare", withAutopilotExclude("jest"), "jest");
checkEqual("npx jest", withAutopilotExclude("npx jest"), "npx jest");
checkEqual("make test", withAutopilotExclude("make test"), "make test");
checkEqual("cargo test", withAutopilotExclude("cargo test"), "cargo test");
checkEqual("go test", withAutopilotExclude("go test ./..."), "go test ./...");
checkEqual("empty string", withAutopilotExclude(""), "");

// -----------------------------------------------------------------------------
// (b) Real vitest run in temporary directory
// -----------------------------------------------------------------------------

console.log("real vitest run");
const masterNodeModules = path.resolve("node_modules");
const vitestBin = path.join(masterNodeModules, ".bin", "vitest");
let vitestAvailable = false;
try {
  vitestAvailable = fs.existsSync(vitestBin) && fs.statSync(vitestBin).isFile();
} catch {}

if (!vitestAvailable) {
  console.log("SKIP: vitest binary missing at", vitestBin);
} else {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-gate-exclude-vitest-"));
  try {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "temp-pkg", type: "module" }, null, 2)
    );

    try {
      fs.symlinkSync(masterNodeModules, path.join(tempDir, "node_modules"), "junction");
    } catch {}

    fs.writeFileSync(
      path.join(tempDir, "ok.test.mjs"),
      [
        'import { test, expect } from "vitest";',
        'test("passes", () => {',
        "  expect(1 + 1).toBe(2);",
        "});",
      ].join("\n")
    );

    const badDir = path.join(tempDir, ".autopilot", "baseline", "k", "files");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "bad.test.mjs"),
      [
        'import { test, expect } from "vitest";',
        'test("fails", () => {',
        "  expect(1 + 1).toBe(3);",
        "});",
      ].join("\n")
    );

    const rawCmd = `${vitestBin} run`;
    const rewrittenCmd = withAutopilotExclude(rawCmd);
    checkEqual("rewritten command appends exclude", rewrittenCmd, `${rawCmd} --exclude "**/.autopilot/**"`);

    const rRewritten = spawnSync(vitestBin, ["run", "--exclude", "**/.autopilot/**"], { cwd: tempDir, encoding: "utf8" });
    check("rewritten command exits 0 (bad test excluded)", rRewritten.status === 0, `status=${rRewritten.status}`);

    const rRaw = spawnSync(vitestBin, ["run"], { cwd: tempDir, encoding: "utf8" });
    check("unrewritten command exits non-zero (bad test discovered and fails)", rRaw.status !== 0, `status=${rRaw.status}`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

console.log("wiring checks");
const autopilotSrc = fs.readFileSync(path.resolve("scripts/autopilot.mjs"), "utf8");
check(
  "autopilot.mjs imports withAutopilotExclude",
  autopilotSrc.includes('import { withAutopilotExclude } from "./gate-autopilot-exclude.mjs";')
);
check(
  "autopilot.mjs passes withAutopilotExclude(command) at gates loop (runGuardedCommand)",
  autopilotSrc.includes('runGuardedCommand(repo,withAutopilotExclude(command),env,shellGuard,{label:"gates.commands"')
);
check(
  "autopilot.mjs passes withAutopilotExclude(command) at runGatesInCwd (runCommandInCwd)",
  autopilotSrc.includes('runCommandInCwd(cwd,withAutopilotExclude(command),env,shellGuard,{label:"gates.commands"')
);

const probeSrc = fs.readFileSync(path.resolve("scripts/command-probe.mjs"), "utf8");
check(
  "command-probe.mjs imports withAutopilotExclude",
  probeSrc.includes('import { withAutopilotExclude } from "./gate-autopilot-exclude.mjs";')
);
check(
  "command-probe.mjs passes withAutopilotExclude(command) to runGuardedCommand in probeTestCommand",
  probeSrc.includes("runGuardedCommand(cwd, withAutopilotExclude(command), env, shellGuard, {")
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
