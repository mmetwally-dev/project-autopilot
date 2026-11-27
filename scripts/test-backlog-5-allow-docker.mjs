#!/usr/bin/env node
// Backlog #5: safety.allow_docker config, validation, schema/example/docs,
// execution-envelope mounts, and identical setup / `ap config` question text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULTS, toRuntimeConfig, toNewLayoutConfig } from "./config-layout.mjs";
import { validateNewConfig } from "./config-validation.mjs";
import { buildDockerEnvelopeArgs, buildExecutionEnvelope, mapEnvironmentIntoEnvelope } from "./execution-envelope.mjs";
import { ALLOW_DOCKER_QUESTION, ALLOW_DOCKER_PROMPT } from "./setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const setupScript = path.join(here, "setup.mjs");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ── 1. Config layout defaults & round-trip ──
check("DEFAULTS.safety.allow_docker is false",
  DEFAULTS.safety.allow_docker === false,
  DEFAULTS.safety);

const rtDefault = toRuntimeConfig(JSON.parse(JSON.stringify(DEFAULTS)));
check("toRuntimeConfig maps default allow_docker=false to safety and policy",
  rtDefault.safety?.allow_docker === false && rtDefault.policy?.allow_docker === false,
  { safety: rtDefault.safety, policy: rtDefault.policy });

const enabledLayout = JSON.parse(JSON.stringify(DEFAULTS));
enabledLayout.safety.allow_docker = true;
const rtEnabled = toRuntimeConfig(enabledLayout);
const layoutRoundTrip = toNewLayoutConfig(rtEnabled);
check("allow_docker=true round-trips layout -> runtime -> layout",
  rtEnabled.safety?.allow_docker === true &&
  rtEnabled.policy?.allow_docker === true &&
  layoutRoundTrip.safety?.allow_docker === true,
  { rtSafety: rtEnabled.safety, rtPolicy: rtEnabled.policy, layoutSafety: layoutRoundTrip.safety });

// ── 2. Validation rejects non-boolean safety.allow_docker ──
const validCfg = JSON.parse(JSON.stringify(DEFAULTS));
validCfg.safety.allow_docker = true;
const vOk = validateNewConfig(validCfg);
check("validateNewConfig accepts boolean safety.allow_docker=true",
  vOk.valid === true,
  vOk.errors);

const badCfg = JSON.parse(JSON.stringify(DEFAULTS));
badCfg.safety.allow_docker = "yes";
const vBad = validateNewConfig(badCfg);
check("validateNewConfig rejects non-boolean safety.allow_docker",
  vBad.valid === false && vBad.errors.some((e) => e.includes("safety.allow_docker")),
  vBad.errors);

// ── 3. Schema, config.example.json, docs/configuration.md contain the key ──
const schema = JSON.parse(fs.readFileSync(path.join(root, "config.schema.json"), "utf8"));
const schemaProp = schema?.properties?.safety?.properties?.allow_docker;
check("config.schema.json contains safety.allow_docker with root-equivalent warning",
  schemaProp?.type === "boolean" &&
  schemaProp?.default === false &&
  /root-equivalent/i.test(String(schemaProp?.description || "")),
  schemaProp);

const example = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
check("config.example.json contains safety.allow_docker: false",
  example?.safety?.allow_docker === false,
  example?.safety);

const docs = fs.readFileSync(path.join(root, "docs", "configuration.md"), "utf8");
check("docs/configuration.md documents safety.allow_docker",
  docs.includes("`safety.allow_docker`") && /root-equivalent/i.test(docs));

// ── 4. buildExecutionEnvelope: default byte-identical vs allow_docker=true binds ──
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-allow-docker-repo-"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-allow-docker-scratch-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-allow-docker-bin-"));
const fakeSockDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-allow-docker-sock-"));
tempDirs.add(repo);
tempDirs.add(scratch);
tempDirs.add(fakeBinDir);
tempDirs.add(fakeSockDir);

const fakeAdapter = path.join(repo, "fake-adapter");
fs.writeFileSync(fakeAdapter, "#!/bin/sh\nexit 0\n");
fs.chmodSync(fakeAdapter, 0o755);

const fakeSocketTarget = path.join(fakeSockDir, "real-docker.sock");
fs.writeFileSync(fakeSocketTarget, "");
const fakeSocketLink = path.join(fakeSockDir, "docker.sock");
fs.symlinkSync(fakeSocketTarget, fakeSocketLink);

const fakeDockerBin = path.join(fakeBinDir, "docker");
const fakeSupabaseBin = path.join(fakeBinDir, "supabase");
fs.writeFileSync(fakeDockerBin, "#!/bin/sh\nexit 0\n");
fs.writeFileSync(fakeSupabaseBin, "#!/bin/sh\nexit 0\n");
fs.chmodSync(fakeDockerBin, 0o755);
fs.chmodSync(fakeSupabaseBin, 0o755);

// Pure bwrap arg generation (runs even inside nested sandboxes without bwrap):
const resolvedSock = fs.realpathSync(fakeSocketTarget);
const resolvedBinDir = fs.realpathSync(fakeBinDir);

const dockerArgsDefault = buildDockerEnvelopeArgs({
  config: {},
  dockerSocketPath: fakeSocketLink,
  hostPath: fakeBinDir
});
const dockerArgsFalse = buildDockerEnvelopeArgs({
  config: { safety: { allow_docker: false } },
  dockerSocketPath: fakeSocketLink,
  hostPath: fakeBinDir
});
check("buildDockerEnvelopeArgs: default and allow_docker=false emit zero extra bwrap args",
  dockerArgsDefault.allowDocker === false &&
  dockerArgsDefault.args.length === 0 &&
  JSON.stringify(dockerArgsDefault.args) === JSON.stringify(dockerArgsFalse.args),
  { dockerArgsDefault, dockerArgsFalse });

const dockerArgsTrue = buildDockerEnvelopeArgs({
  config: { safety: { allow_docker: true } },
  dockerSocketPath: fakeSocketLink,
  hostPath: fakeBinDir
});
const pureSockIdx = dockerArgsTrue.args.indexOf("/var/run/docker.sock");
const pureBinIdx = dockerArgsTrue.args.indexOf(resolvedBinDir);
check("buildDockerEnvelopeArgs: allow_docker=true binds resolved socket to /var/run/docker.sock",
  dockerArgsTrue.allowDocker === true &&
  pureSockIdx >= 2 &&
  dockerArgsTrue.args[pureSockIdx - 2] === "--bind" &&
  dockerArgsTrue.args[pureSockIdx - 1] === resolvedSock,
  dockerArgsTrue.args);

check("buildDockerEnvelopeArgs: allow_docker=true ro-binds docker/supabase binary directory at same path",
  pureBinIdx >= 1 &&
  dockerArgsTrue.args[pureBinIdx - 1] === "--ro-bind" &&
  dockerArgsTrue.args[pureBinIdx + 1] === resolvedBinDir &&
  dockerArgsTrue.dockerBinDirs.includes(resolvedBinDir),
  dockerArgsTrue);

const mappedPure = mapEnvironmentIntoEnvelope(
  { PATH: "/usr/bin:/bin" },
  { available: true, sandbox: { repository: "/workspace/repository", scratch: "/workspace/scratch", dockerBinDirs: dockerArgsTrue.dockerBinDirs } },
  repo,
  scratch
);
check("mapEnvironmentIntoEnvelope adds bound docker/supabase bin dir to PATH",
  String(mappedPure.PATH || "").split(path.delimiter).includes(resolvedBinDir),
  mappedPure.PATH);

// Live buildExecutionEnvelope check (runs when bwrap is usable outside nested sandbox):
const envOmitted = buildExecutionEnvelope({
  repo,
  scratchDir: scratch,
  readOnly: false,
  config: {},
  binary: fakeAdapter,
  args: ["run"],
  dockerSocketPath: fakeSocketLink,
  hostPath: fakeBinDir
});

const envFalse = buildExecutionEnvelope({
  repo,
  scratchDir: scratch,
  readOnly: false,
  config: { safety: { allow_docker: false } },
  binary: fakeAdapter,
  args: ["run"],
  dockerSocketPath: fakeSocketLink,
  hostPath: fakeBinDir
});

if (envOmitted.available && envFalse.available) {
  check("live buildExecutionEnvelope: default config bwrap args are byte-identical to allow_docker=false and have no docker.sock",
    JSON.stringify(envOmitted.args) === JSON.stringify(envFalse.args) &&
    !envFalse.args.includes("/var/run/docker.sock") &&
    !envFalse.args.includes(resolvedBinDir),
    { omittedLen: envOmitted.args.length, falseLen: envFalse.args.length });

  const envTrue = buildExecutionEnvelope({
    repo,
    scratchDir: scratch,
    readOnly: false,
    config: { safety: { allow_docker: true } },
    binary: fakeAdapter,
    args: ["run"],
    dockerSocketPath: fakeSocketLink,
    hostPath: fakeBinDir
  });
  const sockBindIdx = envTrue.args.indexOf("/var/run/docker.sock");
  const binBindIdx = envTrue.args.indexOf(resolvedBinDir);
  check("live buildExecutionEnvelope: allow_docker=true binds resolved socket to /var/run/docker.sock",
    envTrue.available === true &&
    sockBindIdx >= 2 &&
    envTrue.args[sockBindIdx - 2] === "--bind" &&
    envTrue.args[sockBindIdx - 1] === resolvedSock,
    envTrue.args.slice(Math.max(0, sockBindIdx - 3), sockBindIdx + 2));

  check("live buildExecutionEnvelope: allow_docker=true ro-binds docker/supabase binary directory at same path",
    binBindIdx >= 1 &&
    envTrue.args[binBindIdx - 1] === "--ro-bind" &&
    envTrue.args[binBindIdx + 1] === resolvedBinDir,
    envTrue.args.slice(Math.max(0, binBindIdx - 2), binBindIdx + 3));
} else {
  console.log(`SKIP live bwrap envelope assertions (bwrap unavailable in this environment: ${envOmitted.reason})`);
}

// ── 5. Setup (--wizard) and `ap config` (--edit) ask identical question text ──
const EXPECTED_QUESTION = "Let agents use Docker and the Supabase CLI inside the sandbox? (gives root-level access to this machine; only for projects that need a local database) [y/N]";
check("ALLOW_DOCKER_PROMPT matches exact required wording",
  ALLOW_DOCKER_PROMPT === EXPECTED_QUESTION,
  ALLOW_DOCKER_PROMPT);

const systemDirs = process.platform === "win32" ? [] : ["/usr/bin", "/bin"];
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-docker-setup-cli-"));
tempDirs.add(cliDir);
const fakeClaude = path.join(cliDir, "claude");
const realTrue = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
fs.copyFileSync(realTrue, fakeClaude);
fs.chmodSync(fakeClaude, 0o755);

const setupRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-docker-setup-repo-"));
tempDirs.add(setupRepo);

function runSetup(args, stdinLines) {
  const env = {
    ...process.env,
    PATH: [cliDir, ...systemDirs].join(path.delimiter),
    AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [setupScript, ...args, "--repo", setupRepo], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const watchdog = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60000);
    child.on("close", (status) => { clearTimeout(watchdog); resolve({ status, out }); });
    child.stdin.write(stdinLines.map((l) => `${l}\n`).join(""));
    child.stdin.end();
  });
}

// Static verification that setup.mjs uses the single shared askAllowDocker helper
// gated by gatesInScope (which covers both wizardMode / `ap setup` and editMode / `ap config`).
const setupSrc = fs.readFileSync(setupScript, "utf8");
check("setup.mjs shares askAllowDocker across wizardMode (setup) and editMode (ap config) via gatesInScope",
  setupSrc.includes("const gatesInScope =\n      wizardMode ||\n      scope === SCOPE.ALL ||\n      scope === SCOPE.FRAMEWORK;") &&
  setupSrc.includes("const allowDocker = gatesInScope\n      ? await askAllowDocker(current, interactive)") &&
  setupSrc.includes("allow_docker: allowDocker"),
  "setup.mjs wiring check");

// Live setup --wizard & --edit runs (require bwrap for linux-strong runtime mode):
if (envOmitted.available) {
  // Wizard answers: continue (""), 5 roles x (CLI "1", fallback "1") = 10x"1",
  // escalation "1" (No/off), free_models.exclude "" (none), gate command "" (no tests), allow_docker "" (default No).
  const wizardRun = await runSetup(["--wizard"], ["", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "", "", ""]);
  const savedWizard = JSON.parse(fs.readFileSync(path.join(setupRepo, ".autopilot", "config.json"), "utf8"));
  const wizardPromptLine = wizardRun.out.split(/\r?\n/).find((l) => l.includes("Let agents use Docker"));
  check("setup --wizard exits 0, asks the exact question, and defaults allow_docker to false",
    wizardRun.status === 0 &&
    wizardPromptLine?.includes(EXPECTED_QUESTION) &&
    savedWizard?.safety?.allow_docker === false &&
    Array.isArray(savedWizard?.tests?.gate_commands) && savedWizard.tests.gate_commands.length === 0,
    { status: wizardRun.status, wizardPromptLine, allow_docker: savedWizard?.safety?.allow_docker, gates: savedWizard?.tests?.gate_commands });

  // ap config (--edit): scope 3 (Framework / safety), gate "" (no tests), allow_docker "y" -> true.
  const editRun = await runSetup(["--edit"], ["3", "", "y"]);
  const savedEdit = JSON.parse(fs.readFileSync(path.join(setupRepo, ".autopilot", "config.json"), "utf8"));
  const editPromptLine = editRun.out.split(/\r?\n/).find((l) => l.includes("Let agents use Docker"));
  check("ap config (--edit) exits 0, asks the exact identical question, and saves allow_docker=true on 'y'",
    editRun.status === 0 &&
    editPromptLine === wizardPromptLine &&
    savedEdit?.safety?.allow_docker === true,
    { status: editRun.status, editPromptLine, wizardPromptLine, allow_docker: savedEdit?.safety?.allow_docker });

  // ap config (--edit) when allow_docker is already true: shows [Y/n] and Enter keeps true.
  const editKeepRun = await runSetup(["--edit"], ["3", "", ""]);
  const savedEditKeep = JSON.parse(fs.readFileSync(path.join(setupRepo, ".autopilot", "config.json"), "utf8"));
  const editKeepPromptLine = editKeepRun.out.split(/\r?\n/).find((l) => l.includes("Let agents use Docker"));
  check("ap config (--edit) shows [Y/n] when already true and Enter preserves allow_docker=true",
    editKeepRun.status === 0 &&
    editKeepPromptLine?.includes(`${ALLOW_DOCKER_QUESTION} [Y/n]`) &&
    savedEditKeep?.safety?.allow_docker === true,
    { status: editKeepRun.status, editKeepPromptLine, allow_docker: savedEditKeep?.safety?.allow_docker });

  // ap config (--edit) when allow_docker is true: 'n' turns it back off to false.
  const editOffRun = await runSetup(["--edit"], ["3", "", "n"]);
  const savedEditOff = JSON.parse(fs.readFileSync(path.join(setupRepo, ".autopilot", "config.json"), "utf8"));
  check("ap config (--edit) saves allow_docker=false on 'n'",
    editOffRun.status === 0 &&
    savedEditOff?.safety?.allow_docker === false,
    { status: editOffRun.status, allow_docker: savedEditOff?.safety?.allow_docker });
} else {
  console.log(`SKIP live setup --wizard/--edit subprocess assertions (bwrap unavailable in this environment: ${envOmitted.reason})`);
}

// ── 6. Live docker + supabase inside a real allow_docker=true envelope ──
function findOnHostPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

const realDockerSockExists = fs.existsSync("/var/run/docker.sock");
const hostDockerBin = findOnHostPath("docker");
const hostSupabaseBin = findOnHostPath("supabase");

if (!envOmitted.available) {
  console.log(`SKIP live docker/supabase-in-envelope test (bwrap unavailable: ${envOmitted.reason})`);
} else if (!realDockerSockExists || !hostDockerBin) {
  const reasons = [];
  if (!realDockerSockExists) reasons.push("/var/run/docker.sock missing");
  if (!hostDockerBin) reasons.push("docker not on PATH");
  console.log(`SKIP live docker-in-envelope test (${reasons.join(", ")})`);
} else {
  const liveDockerEnv = buildExecutionEnvelope({
    repo,
    scratchDir: scratch,
    readOnly: false,
    config: { safety: { allow_docker: true } },
    binary: hostDockerBin,
    args: ["version", "--format", "{{.Server.Version}}"]
  });
  check("live docker envelope available", liveDockerEnv.available === true, liveDockerEnv.reason || liveDockerEnv.detail);
  if (liveDockerEnv.available) {
    const mapped = mapEnvironmentIntoEnvelope(process.env, liveDockerEnv, repo, scratch);
    const res = spawnSync(liveDockerEnv.binary, liveDockerEnv.args, {
      cwd: liveDockerEnv.cwd,
      env: mapped,
      encoding: "utf8",
      timeout: 15000,
      shell: false
    });
    const out = String(res.stdout || "").trim();
    check("live docker version inside allow_docker=true envelope exits 0 with non-empty server version",
      res.status === 0 && out.length > 0,
      { status: res.status, stdout: out, stderr: String(res.stderr || "").trim() });
  }

  if (!hostSupabaseBin) {
    console.log("SKIP live supabase-in-envelope test (supabase not on PATH)");
  } else {
    const liveSupaEnv = buildExecutionEnvelope({
      repo,
      scratchDir: scratch,
      readOnly: false,
      config: { safety: { allow_docker: true } },
      binary: hostSupabaseBin,
      args: ["--version"]
    });
    check("live supabase envelope available", liveSupaEnv.available === true, liveSupaEnv.reason || liveSupaEnv.detail);
    if (liveSupaEnv.available) {
      const mapped = mapEnvironmentIntoEnvelope(process.env, liveSupaEnv, repo, scratch);
      const res = spawnSync(liveSupaEnv.binary, liveSupaEnv.args, {
        cwd: liveSupaEnv.cwd,
        env: mapped,
        encoding: "utf8",
        timeout: 15000,
        shell: false
      });
      const out = String(res.stdout || "").trim();
      check("live supabase --version inside allow_docker=true envelope exits 0 with non-empty output",
        res.status === 0 && out.length > 0,
        { status: res.status, stdout: out, stderr: String(res.stderr || "").trim() });
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
