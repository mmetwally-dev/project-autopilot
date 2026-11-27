import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  detectExtraGateCommands,
  detectPackageManager,
  formatExtraGateCommandsPrompt,
  mergeExtraGateCommands,
} from "./detect-test-command.mjs";
import { planReviewGateClaimRule } from "./autopilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const setupScript = path.join(here, "setup.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, detail);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-s15-5-"));
const delimiter = process.platform === "win32" ? ";" : ":";
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const systemDirs = process.platform === "win32"
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ["/usr/bin", "/bin"];

function makeFakeCliDir() {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "fake-cli-"));
  const fakeClaude = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, '@echo off\nif "%1"=="--version" (echo claude-test & exit /b 0)\nif "%1"=="--help" (echo --model --effort --resume-last & exit /b 0)\nexit /b 0\n');
  } else {
    const realTrue = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return binDir;
}

function baseConfig(commands = []) {
  const one = () => ({
    adapter: "claude",
    model: "",
    reasoning: "",
    variant: "",
    resume: true,
    model_source: "default",
    model_verified_at: null,
    capabilities_verified_at: null,
  });
  return {
    schema_version: "4.0",
    project: {
      repo: ".",
      planning_framework: "standalone",
      state_file: ".autopilot/state.json",
      runs_dir: ".autopilot/runs",
    },
    roles: {
      planner: one(),
      plan_reviewer: one(),
      implementer: one(),
      code_reviewer: one(),
      verifier: one(),
    },
    workflow: {},
    gates: { env_allowlist: [], require_reviewer: true, network_isolation: true, commands },
    policy: {
      failure_budgets: {
        implementationFailureBudget: 3,
        verificationFailureBudget: 3,
        adapterRetryBudget: 2,
        infrastructureRetryBudget: 2,
      },
    },
    safety: {},
    planning: {},
    capabilities: {
      project_defaults: [],
      role_requirements: {},
      safety_denied: [],
      legacy_text_inference: false,
      verification: { browser: "native", require_browser: "when-task-requires" },
    },
    config_metadata: { migrated_from: "3.0", last_migrated_at: "2026-01-01T00:00:00.000Z" },
  };
}

function runSetupScripted({ repo, binDir, modeArgs, answers, forceInteractive = true, timeoutMs = 15000 }) {
  const env = { ...process.env, PATH: [binDir, ...systemDirs].join(delimiter) };
  if (forceInteractive) env.AUTOPILOT_SETUP_FORCE_INTERACTIVE = "1";
  else delete env.AUTOPILOT_SETUP_FORCE_INTERACTIVE;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [setupScript, ...modeArgs, "--repo", repo], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut, stdout, stderr });
    });
    if (answers) {
      child.stdin.write(answers.map((a) => `${a}\n`).join(""));
    }
    child.stdin.end();
  });
}

function readGateCommands(repo) {
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8"));
  return cfg.tests?.gate_commands ?? cfg.gates?.commands ?? [];
}

try {
  // 1. Root scripts detection (npm default)
  {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "root-npm-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "root-app",
      scripts: { test: "vitest run", "type-check": "tsc --noEmit", lint: "eslint ." },
      workspaces: ["apps/*"],
    }));
    fs.mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
    fs.writeFileSync(path.join(dir, "apps", "web", "package.json"), JSON.stringify({
      name: "@app/web",
      scripts: { typecheck: "tsc --noEmit", lint: "eslint ." },
    }));
    const extras = detectExtraGateCommands(dir);
    check("root scripts preferred over workspace scripts (npm)",
      JSON.stringify(extras) === JSON.stringify(["npm run type-check", "npm run lint"]), extras);
  }

  // 2. Alternate root type-check script names (`typecheck`, `tsc`)
  {
    const dir1 = fs.mkdtempSync(path.join(tmpRoot, "root-typecheck-"));
    fs.writeFileSync(path.join(dir1, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    check("detects root typecheck script",
      JSON.stringify(detectExtraGateCommands(dir1)) === JSON.stringify(["npm run typecheck"]));

    const dir2 = fs.mkdtempSync(path.join(tmpRoot, "root-tsc-"));
    fs.writeFileSync(path.join(dir2, "package.json"), JSON.stringify({ scripts: { tsc: "tsc --noEmit" } }));
    check("detects root tsc script",
      JSON.stringify(detectExtraGateCommands(dir2)) === JSON.stringify(["npm run tsc"]));
  }

  // 3. Workspace-only scripts (npm workspaces)
  {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "ws-npm-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "mono",
      private: true,
      scripts: { test: "vitest run" },
      workspaces: ["apps/*", "packages/shared"],
    }));
    fs.mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
    fs.writeFileSync(path.join(dir, "apps", "web", "package.json"), JSON.stringify({
      name: "@mono/web",
      scripts: { "type-check": "tsc --noEmit", lint: "eslint ." },
    }));
    fs.mkdirSync(path.join(dir, "packages", "shared"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", "shared", "package.json"), JSON.stringify({
      name: "@mono/shared",
      scripts: { typecheck: "tsc --noEmit" },
    }));
    const extras = detectExtraGateCommands(dir);
    check("workspace-only scripts detected for npm workspaces",
      JSON.stringify(extras) === JSON.stringify([
        "npm --workspace @mono/web run type-check",
        "npm --workspace @mono/shared run typecheck",
        "npm --workspace @mono/web run lint",
      ]), extras);
  }

  // 4. Yarn and pnpm forms
  {
    const yarnDir = fs.mkdtempSync(path.join(tmpRoot, "yarn-"));
    fs.writeFileSync(path.join(yarnDir, "yarn.lock"), "# yarn lockfile\n");
    fs.writeFileSync(path.join(yarnDir, "package.json"), JSON.stringify({
      scripts: { "type-check": "tsc --noEmit", lint: "eslint ." },
    }));
    check("detectPackageManager detects yarn from yarn.lock", detectPackageManager(yarnDir) === "yarn");
    check("yarn form returned for root scripts",
      JSON.stringify(detectExtraGateCommands(yarnDir)) === JSON.stringify(["yarn run type-check", "yarn run lint"]),
      detectExtraGateCommands(yarnDir));

    const pnpmDir = fs.mkdtempSync(path.join(tmpRoot, "pnpm-"));
    fs.writeFileSync(path.join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    fs.writeFileSync(path.join(pnpmDir, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit", lint: "eslint ." },
    }));
    check("detectPackageManager detects pnpm from pnpm-lock.yaml", detectPackageManager(pnpmDir) === "pnpm");
    check("pnpm form returned for root scripts",
      JSON.stringify(detectExtraGateCommands(pnpmDir)) === JSON.stringify(["pnpm run typecheck", "pnpm run lint"]),
      detectExtraGateCommands(pnpmDir));
  }

  // 5. None present
  {
    const noneDir = fs.mkdtempSync(path.join(tmpRoot, "none-"));
    fs.writeFileSync(path.join(noneDir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    check("returns [] when no type-check/lint scripts exist", detectExtraGateCommands(noneDir).length === 0);
  }

  // 6. Pure merge helper
  check("mergeExtraGateCommands: Enter appends missing extras",
    JSON.stringify(mergeExtraGateCommands({
      baseCommands: ["npm test"],
      extraCommands: ["npm run type-check", "npm run lint"],
      answer: "",
    })) === JSON.stringify(["npm test", "npm run type-check", "npm run lint"]));
  check("mergeExtraGateCommands: n keeps tests only",
    JSON.stringify(mergeExtraGateCommands({
      baseCommands: ["npm test"],
      extraCommands: ["npm run type-check", "npm run lint"],
      answer: "n",
    })) === JSON.stringify(["npm test"]));

  // 7. End-to-end: ap config (--edit) AND ap setup (--wizard) show identical question & wire Enter vs n
  const binDir = makeFakeCliDir();
  const expectedPrompt = formatExtraGateCommandsPrompt(["npm run type-check", "npm run lint"]).trim();

  // 7a. ap config (--edit): shows extra gate question; if bwrap is available so setup saves, Enter adds type-check & lint
  {
    const repo = fs.mkdtempSync(path.join(tmpRoot, "edit-yes-"));
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig(["npx vitest run"]), null, 2));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "edit-yes",
      scripts: { test: "vitest run", "type-check": "tsc --noEmit", lint: "eslint ." },
    }));
    const r = await runSetupScripted({ repo, binDir, modeArgs: ["--edit"], answers: ["3", "", "", "n", "", "", ""] });
    const out = `${r.stdout}\n${r.stderr}`;
    const bwrapBlocked = /bubblewrap_sandbox_probe_unusable/.test(out);
    check("ap config (--edit) shows extra gate question", !r.timedOut && out.includes(expectedPrompt), out.slice(-1200));
    if (!bwrapBlocked) {
      check("ap config (--edit) exits 0 and Enter adds detected type-check and lint",
        r.status === 0 && JSON.stringify(readGateCommands(repo)) === JSON.stringify(["npx vitest run", "npm run type-check", "npm run lint"]),
        { status: r.status, saved: readGateCommands(repo) });
    }
  }

  // 7b. ap config (--edit): n keeps tests only
  {
    const repo = fs.mkdtempSync(path.join(tmpRoot, "edit-no-"));
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig(["npx vitest run"]), null, 2));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "edit-no",
      scripts: { test: "vitest run", "type-check": "tsc --noEmit", lint: "eslint ." },
    }));
    const r = await runSetupScripted({ repo, binDir, modeArgs: ["--edit"], answers: ["3", "", "n", "n", "", "", ""] });
    const out = `${r.stdout}\n${r.stderr}`;
    const bwrapBlocked = /bubblewrap_sandbox_probe_unusable/.test(out);
    check("ap config (--edit) 'n' branch prints identical extra gate question", !r.timedOut && out.includes(expectedPrompt), out.slice(-1200));
    if (!bwrapBlocked) {
      check("ap config (--edit) with 'n' keeps tests only",
        r.status === 0 && JSON.stringify(readGateCommands(repo)) === JSON.stringify(["npx vitest run"]),
        { status: r.status, saved: readGateCommands(repo) });
    }
  }

  // 7c. ap setup (--wizard): shows the exact same question and Enter adds them
  {
    const repo = fs.mkdtempSync(path.join(tmpRoot, "wizard-yes-"));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "wizard-yes",
      scripts: { test: "vitest run", "type-check": "tsc --noEmit", lint: "eslint ." },
    }));
    const r = await runSetupScripted({
      repo,
      binDir,
      modeArgs: ["--wizard"],
      answers: ["", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "", "", "n", "", "", "", "", ""],
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const bwrapBlocked = /bubblewrap_sandbox_probe_unusable/.test(out);
    check("ap setup (--wizard) shows the exact same extra gate question as ap config",
      !r.timedOut && out.includes(expectedPrompt), out.slice(-1500));
    if (!bwrapBlocked) {
      const saved = readGateCommands(repo);
      check("ap setup (--wizard) exits 0 and Enter saves test + type-check + lint",
        r.status === 0 && saved.includes("npm run type-check") && saved.includes("npm run lint"),
        { status: r.status, saved });
    }
  }

  // 7d. Non-interactive setup does NOT silently alter existing gate_commands
  {
    const repo = fs.mkdtempSync(path.join(tmpRoot, "noninteractive-"));
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(baseConfig(["npx vitest run"]), null, 2));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "noninteractive",
      scripts: { test: "vitest run", "type-check": "tsc --noEmit", lint: "eslint ." },
    }));
    const r = await runSetupScripted({ repo, binDir, modeArgs: ["--edit"], answers: null, forceInteractive: false });
    const out = `${r.stdout}\n${r.stderr}`;
    check("non-interactive setup does not ask extra gate question and keeps existing gate_commands unchanged",
      !out.includes(expectedPrompt) && JSON.stringify(readGateCommands(repo)) === JSON.stringify(["npx vitest run"]),
      { status: r.status, saved: readGateCommands(repo) });
  }

  // 7e. Wiring check in setup.mjs: both setup and ap config share the same mergeExtraGateCommands -> finalGateCommands -> gates.commands path
  {
    const setupSrc = fs.readFileSync(setupScript, "utf8");
    check("setup.mjs wires detectExtraGateCommands + formatExtraGateCommandsPrompt + mergeExtraGateCommands into finalGateCommands",
      setupSrc.includes("detectExtraGateCommands(repo)")
      && setupSrc.includes("formatExtraGateCommandsPrompt(missingExtraGateCommands)")
      && setupSrc.includes("const resolvedGateCommands = mergeExtraGateCommands(")
      && setupSrc.includes("let finalGateCommands = resolvedGateCommands;"));
  }

  // 8. Plan/tasks reviewer brief carries configured gate commands + "gate claim not configured" rule in BOTH loops
  const ruleWithVitest = planReviewGateClaimRule({ gates: { commands: ["npx vitest run"] } });
  check("planReviewGateClaimRule lists configured gate commands",
    ruleWithVitest.includes("Configured orchestrator gate commands: npx vitest run"), ruleWithVitest);
  check("planReviewGateClaimRule names 'gate claim not configured' finding",
    ruleWithVitest.includes('gate claim not configured') && /type-check/i.test(ruleWithVitest) && /lint/i.test(ruleWithVitest),
    ruleWithVitest);
  check("planReviewGateClaimRule handles empty gate commands as (none)",
    planReviewGateClaimRule({ gates: { commands: [] } }).includes("Configured orchestrator gate commands: (none)"));

  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const standalonePlanIdx = autopilotSrc.indexOf("Review the standalone Autopilot plan before implementation.");
  const standaloneSlice = autopilotSrc.slice(standalonePlanIdx, standalonePlanIdx + 3000);
  check("standalone plan review brief includes planReviewGateClaimRule(c)",
    standaloneSlice.includes("planReviewGateClaimRule(c)"));

  const speckitTasksIdx = autopilotSrc.indexOf("const tasksGateNote = String(step.id");
  const speckitSlice = autopilotSrc.slice(speckitTasksIdx, speckitTasksIdx + 2000);
  check("SpecKit plan/tasks review brief includes planReviewGateClaimRule(c)",
    speckitSlice.includes("planReviewGateClaimRule(c)"));
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
