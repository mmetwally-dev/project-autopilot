#!/usr/bin/env node
// Backlog #12(c): choosing "Use CLI default" for an OpenCode role in setup /
// `ap config` prints a one-line warning that OpenCode then picks its own
// default inside the sandbox and may use a paid provider. An explicit model
// prints no such warning. Hermetic subprocess test: fake CLI + temp repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const setupScript = path.join(here, "setup.mjs");
const delimiter = process.platform === "win32" ? ";" : ":";
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const systemDirs = process.platform === "win32"
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ["/usr/bin", "/bin"];

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const MODELS = ["opencode/paid-model", "opencode/free-model-free"];
const tempDirs = [];
function owned(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeOpenCode() {
  const binDir = owned("ap-open-default-bin-");
  const server = path.join(binDir, "fake-opencode.mjs");
  fs.writeFileSync(server, [
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { process.stdout.write("opencode-test 1.0.0\\n"); process.exit(0); }',
    'if (a[0] === "--help") { process.stdout.write("Usage: opencode\\n  -m, --model <name>\\n"); process.exit(0); }',
    'if (a[0] === "run" && a[1] === "--help") { process.stdout.write("Usage: opencode run\\n  -m, --model <name>\\n"); process.exit(0); }',
    'if (a[0] === "models" && a[1] === "--verbose") { process.exit(1); }',
    `if (a[0] === "models") { process.stdout.write(${JSON.stringify(MODELS.join("\n") + "\n")}); process.exit(0); }`,
    'process.exit(0);',
  ].join("\n"));
  if (process.platform === "win32") {
    const binary = path.join(binDir, "opencode.cmd");
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`);
  } else {
    const binary = path.join(binDir, "opencode");
    fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
    fs.chmodSync(binary, 0o755);
  }
  return binDir;
}

function role(adapter, model = "") {
  return {
    adapter, model, reasoning: "", variant: "", resume: false,
    model_source: model ? "live" : "default", model_verified_at: null, capabilities_verified_at: null,
  };
}

function seedRepo() {
  const repo = owned("ap-open-default-repo-");
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  const config = {
    schema_version: "4.0",
    project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
    roles: {
      planner: role("opencode"),
      plan_reviewer: role("opencode"),
      implementer: role("opencode"),
      code_reviewer: role("opencode"),
      verifier: role("opencode"),
    },
    workflow: {},
    gates: {env_allowlist: [], require_reviewer: true, network_isolation: true, commands: []},
    policy: {failure_budgets: {implementationFailureBudget: 4, verificationFailureBudget: 4, adapterRetryBudget: 3, infrastructureRetryBudget: 3}},
    safety: {},
    planning: {},
    capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}},
  };
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify(config, null, 2));
  return repo;
}

function runSetup(repo, binDir, answers) {
  const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter), AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupScript, "--edit", "--repo", repo], {cwd: root, env, stdio: ["pipe", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 30000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => {
      clearTimeout(watchdog);
      resolve({status, stdout, stderr, combined: `${stdout}\n${stderr}`});
    });
    child.stdin.end(answers.map(answer => `${answer}\n`).join(""));
  });
}

const WARNING = /Warning: Planner: "Use CLI default" makes OpenCode pick its own default model inside the sandbox, which may be a paid provider you are logged into/;

try {
  // scope=One role, role=planner, adapter=opencode, model=Use CLI default,
  // fallbacks=Keep current. The escalation question defaults to No.
  {
    const binDir = makeFakeOpenCode();
    const repo = seedRepo();
    const run = await runSetup(repo, binDir, ["2", "1", "1", "1", "1"]);
    check("CLI default: ap config exits 0", run.status === 0, run.combined.slice(-2000));
    check("CLI default: the warning is printed exactly once", run.combined.split("\n").filter(line => WARNING.test(line)).length === 1, run.combined.slice(-3000));
    check("CLI default: the warning names the paid-provider risk", run.combined.includes("may be a paid provider you are logged into"), run.combined.slice(-3000));
    check("CLI default: the warning tells the operator to choose an explicit model", /choose an explicit model to be sure/.test(run.combined), run.combined.slice(-3000));
    const saved = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8"));
    check("CLI default: the role still saves the empty model (warning, not block)", saved.roles.planner.model === "", saved.roles.planner);
  }

  // Same flow with an explicit live model: no warning, model saved.
  {
    const binDir = makeFakeOpenCode();
    const repo = seedRepo();
    const run = await runSetup(repo, binDir, ["2", "1", "1", "3", "1"]);
    check("explicit model: ap config exits 0", run.status === 0, run.combined.slice(-2000));
    check("explicit model: no CLI-default warning", !WARNING.test(run.combined), run.combined.slice(-3000));
    const saved = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8"));
    check("explicit model: the live id is saved", saved.roles.planner.model === "opencode/free-model-free", saved.roles.planner);
  }

  // A non-opencode role on the CLI default is not affected.
  {
    const repo = seedRepo();
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const name of Object.keys(config.roles)) config.roles[name] = role("cursor");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const cursor = path.join(owned("ap-open-default-cursor-"), process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent");
    const trueBin = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
    if (process.platform === "win32") fs.writeFileSync(cursor, "@echo off\r\nexit /b 0\r\n");
    else { fs.copyFileSync(trueBin, cursor); fs.chmodSync(cursor, 0o755); }
    const binDir = path.dirname(cursor);
    const run = await runSetup(repo, binDir, ["2", "1", "1", "1", "1"]);
    check("cursor CLI default: exits 0", run.status === 0, run.combined.slice(-2000));
    check("cursor CLI default: no OpenCode warning", !WARNING.test(run.combined), run.combined.slice(-3000));
  }
} finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

if (failures) {
  console.error(`${failures} setup OpenCode CLI-default warning check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
