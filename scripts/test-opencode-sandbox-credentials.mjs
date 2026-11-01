#!/usr/bin/env node
// Backlog #14: OpenCode 2 paid-provider models inside the bubblewrap sandbox.
//
// OpenCode 2 keeps provider credentials in its own data store, so a sandbox
// with a fresh HOME only knows the built-in `opencode` provider. The fix
// exports exactly one integration on the host (`opencode auth export
// <provider>`) and pipes it straight into `opencode auth import` with a
// private XDG data root, then mounts that data dir into the envelope.
//
// Every OpenCode invocation here is a fake shell script. The real CLI is
// never asked to print credentials: the fake records its argv, stdin and
// XDG_DATA_HOME in a test-owned log outside the repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
  openCodeModelProvider,
  openCodeSandboxCredentialsRequired,
  preflightOpenCodeSandboxCredentials,
  openCodeSandboxCredentialsPreflightMessage,
  prepareOpenCodeSandboxCredentials,
  openCodeCredentialDataRoot,
  exportHasProvider
} from "./opencode-credentials.mjs";
import {buildExecutionEnvelope, SANDBOX_HOME} from "./execution-envelope.mjs";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, runAutopilot, cleanup, withoutOuterGitGuard
} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const agents = JSON.parse(fs.readFileSync(path.join(root, "adapters", "agents.json"), "utf8")).adapters;
const sandboxDataPath = `${SANDBOX_HOME}/.local/share/opencode`;
const FAKE_SECRET = "FAKE";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-opencode-credentials-test-"));
process.on("exit", () => {
  try { fs.rmSync(temporaryRoot, {recursive: true, force: true}); } catch { /* best-effort */ }
});

const fakeHelp2 = [
  "Usage: opencode run [message..]",
  "  -m, --model <provider/model#variant>  model to use",
  ""
].join("\n");
const fakeHelp1 = [
  "Usage: opencode run [message..]",
  "  -m, --model <name>  model to use",
  "  --variant <level>   reasoning level",
  ""
].join("\n");
const fakeApi2 = JSON.stringify({
  data: [{
    providerID: "deepseek",
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    enabled: true,
    status: "active",
    variants: [{id: "low"}, {id: "high"}]
  }]
});

// Real OpenCode 2.2.0 `auth export <provider>` shape: a JSON array, one object
// per stored account. The old object-keyed form must not be required.
const fakeExport2 = JSON.stringify([{
  id: "deepseek",
  integrationID: "deepseek",
  label: "DeepSeek",
  active: true,
  value: {type: "api", key: FAKE_SECRET}
}]);

// The parser shipped before the 2.2.0 follow-up. Kept here only to prove the
// fixture really exercises the array form: this parser must reject it.
function objectKeyedExportHasProvider(text, provider) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const wanted = provider.toLowerCase();
    return Object.keys(parsed).some((key) =>
      key.toLowerCase() === wanted && parsed[key] != null && typeof parsed[key] === "object");
  } catch {
    return false;
  }
}

// One self-contained POSIX file: the envelope mounts it as the external
// binary, so it must not depend on a sibling script.
function writeFakeOpenCode(binDir, {generation = "2", mode = "pass"} = {}) {
  const log = path.join(binDir, `fake-opencode-${generation}-${mode}.log`);
  const binary = path.join(binDir, "opencode");
  const help = generation === "2" ? fakeHelp2 : fakeHelp1;
  const script = `#!/bin/sh
set -u
LOG=${JSON.stringify(log)}
MODE=${JSON.stringify(mode)}
GEN=${JSON.stringify(generation)}
if [ "\${1:-}" = "--version" ]; then
  echo "opencode \${GEN}.0.0"
  exit 0
fi
if [ "\${1:-}" = "--help" ]; then
  echo "Usage: opencode"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "--help" ]; then
  cat <<'HELP'
${help}HELP
  exit 0
fi
if [ "\${1:-}" = "api" ] && [ "\${2:-}" = "GET" ] && [ "\${3:-}" = "/api/model" ]; then
  if [ "$GEN" = "2" ]; then
    printf '%s' '${fakeApi2}'
    exit 0
  fi
  exit 1
fi
if [ "\${1:-}" = "models" ]; then
  if [ "$GEN" = "2" ]; then
    echo "opencode/deepseek-v4.1-flash-free"
    echo "deepseek/deepseek-flash"
  else
    echo "deepseek/deepseek-flash"
  fi
  exit 0
fi
if [ "\${1:-}" = "auth" ]; then
  case "\${2:-}" in
    list)
      echo "AUTH_LIST_CALL" >> "$LOG"
      if [ "$MODE" = "export-fail" ] || [ "$MODE" = "no-credential" ]; then
        echo "opencode  OpenCode            stored"
      else
        echo "deepseek  DeepSeek            stored"
      fi
      exit 0
      ;;
    export)
      echo "EXPORT_ARGS=$*" >> "$LOG"
      if [ "$MODE" = "export-fail" ]; then
        echo "export failed" >&2
        exit 1
      fi
      if [ "$MODE" = "no-credential" ]; then
        printf '%s' '[]'
        exit 0
      fi
      printf '%s' '${fakeExport2}'
      exit 0
      ;;
    import)
      mkdir -p "$XDG_DATA_HOME/opencode"
      chmod 700 "$XDG_DATA_HOME" "$XDG_DATA_HOME/opencode" 2>/dev/null || true
      STDIN_TEXT=$(cat)
      {
        echo "IMPORT_ARGS=$*"
        echo "IMPORT_XDG=$XDG_DATA_HOME"
        echo "IMPORT_MODE=$(stat -c %a "$XDG_DATA_HOME" 2>/dev/null || echo unknown)"
        echo "IMPORT_STDIN_BEGIN"
        printf '%s\\n' "$STDIN_TEXT"
        echo "IMPORT_STDIN_END"
      } >> "$LOG"
      printf '%s\\n' "$STDIN_TEXT" > "$XDG_DATA_HOME/opencode/opencode.db"
      exit 0
      ;;
  esac
fi
if [ "\${1:-}" = "run" ]; then
  if [ -f "$HOME/.local/share/opencode/opencode.db" ]; then
    echo "CREDENTIAL_MOUNT_OK" >&2
  else
    echo "CREDENTIAL_MOUNT_MISSING" >&2
  fi
  echo "fake verifier output"
  exit 0
fi
exit 1
`;
  fs.writeFileSync(binary, script);
  fs.chmodSync(binary, 0o755);
  return {binary, log, adapter: {...agents.opencode, binary}};
}

function configureVerifier(repo, model) {
  writeConfig(repo, {planningFramework: "standalone"});
  const configPath = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.roles.verifier = {
    ...config.roles.verifier,
    adapter: "opencode",
    model,
    reasoning: "",
    variant: "",
    resume: false
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
}

function runVerifyFile(repo, binDir) {
  const criteria = path.join(repo, "criteria.md");
  fs.writeFileSync(criteria, [
    "# Criteria",
    "",
    "- [ ] the fixture criterion is satisfied",
    ""
  ].join("\n"));
  const base = withoutOuterGitGuard(process.env);
  const env = {...base, PATH: `${binDir}${path.delimiter}${base.PATH || ""}`};
  const result = spawnSync(process.execPath, [path.join(root, "bin", "ap.cjs"), "verify-file", criteria], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status,
    timedOut: !!result.error && result.error.code === "ETIMEDOUT",
    output: `${result.stdout || ""}\n${result.stderr || ""}`
  };
}

function readLog(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function textFiles(dir) {
  const files = [];
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  walk(dir);
  return files;
}

function secretOccurrences(dir) {
  const hits = [];
  for (const file of textFiles(dir)) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (text.includes(FAKE_SECRET)) hits.push(path.relative(dir, file));
  }
  return hits;
}

function hasText(dir, needle) {
  return textFiles(dir).some((file) => {
    try { return fs.readFileSync(file, "utf8").includes(needle); } catch { return false; }
  });
}

function parseImport(log) {
  const args = log.match(/^IMPORT_ARGS=(.+)$/m)?.[1] || null;
  const xdg = log.match(/^IMPORT_XDG=(.+)$/m)?.[1] || null;
  const mode = log.match(/^IMPORT_MODE=(.+)$/m)?.[1] || null;
  const stdin = log.match(/IMPORT_STDIN_BEGIN\n([\s\S]*?)\nIMPORT_STDIN_END/)?.[1] ?? null;
  return {args, xdg, mode, stdin};
}

// ── Pure vocabulary (every platform) ─────────────────────────────────────
check("provider: #level suffix is ignored",
  openCodeModelProvider("deepseek/deepseek-flash#low") === "deepseek");
check("provider: built-in opencode provider",
  openCodeModelProvider("opencode/deepseek-v4.1-flash-free") === "opencode");
check("provider: a bare model has no provider to export",
  openCodeModelProvider("sonnet[1m]") === null);
check("required: v2 + paid provider needs credentials",
  openCodeSandboxCredentialsRequired({
    adapterId: "opencode",
    adapter: agents.opencode,
    model: "deepseek/deepseek-flash#low",
    detect: () => "2"
  }) === true);
check("required: v2 + built-in provider needs nothing",
  openCodeSandboxCredentialsRequired({
    adapterId: "opencode",
    adapter: agents.opencode,
    model: "opencode/deepseek-v4.1-flash-free",
    detect: () => "2"
  }) === false);
check("required: v1 never needs the v2 import path",
  openCodeSandboxCredentialsRequired({
    adapterId: "opencode",
    adapter: agents.opencode,
    model: "deepseek/deepseek-flash#low",
    detect: () => "1"
  }) === false);

// ── Export shape: real 2.2.0 array, with the old object form still accepted ─
check("export: real 2.2.0 array shape is accepted (integrationID, case-insensitive)",
  exportHasProvider(fakeExport2, "DeepSeek") === true, fakeExport2);
check("export: the old object-keyed parser rejects that array (so the array form is what is tested)",
  objectKeyedExportHasProvider(fakeExport2, "deepseek") === false, fakeExport2);
check("export: the old object-keyed form is still accepted",
  exportHasProvider(JSON.stringify({deepseek: {type: "api", key: FAKE_SECRET}}), "deepseek") === true);
check("export: an array entry for a different provider is rejected",
  exportHasProvider(fakeExport2, "openai") === false, fakeExport2);

// ── D. Preflight stops when auth list lacks the provider ──────────────────
{
  const config = {roles: {planner: {adapter: "opencode", model: "deepseek/deepseek-flash#low"}}};
  const configAgents = {opencode: {...agents.opencode, binary: "/fake/opencode"}};
  const missing = await preflightOpenCodeSandboxCredentials({
    config,
    agents: configAgents,
    detect: () => "2",
    listProviders: () => ({ok: true, providers: ["opencode"]})
  });
  check("preflight: missing provider stops the run",
    missing.ok === false && missing.problems.length === 1
    && missing.problems[0].provider === "deepseek", missing);
  const message = openCodeSandboxCredentialsPreflightMessage(missing, configAgents);
  check("preflight: message names role, provider and the fix",
    message.includes("role 'planner'") && message.includes("provider 'deepseek'")
    && message.includes("opencode auth login") && message.includes("AUTH_REQUIRED"), message);

  const present = await preflightOpenCodeSandboxCredentials({
    config,
    agents: configAgents,
    detect: () => "2",
    listProviders: () => ({ok: true, providers: ["opencode", "deepseek"]})
  });
  check("preflight: a listed provider passes", present.ok === true && present.problems.length === 0, present);

  const versionOne = await preflightOpenCodeSandboxCredentials({
    config,
    agents: configAgents,
    detect: () => "1",
    listProviders: () => ({ok: true, providers: []})
  });
  check("preflight: v1 is never checked", versionOne.ok === true, versionOne);
}

// ── D2. `ap run` stops before any role when auth list lacks the provider ──
if (process.platform !== "win32") {
  const repo = makeFixtureRepo("opencode-creds-preflight");
  const binDir = makeFixtureBin("opencode-creds-preflight");
  try {
    const fake = writeFakeOpenCode(binDir, {generation: "2", mode: "no-credential"});
    writeConfig(repo, {planningFramework: "standalone"});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner = {
      ...config.roles.planner,
      adapter: "opencode",
      model: "deepseek/deepseek-flash",
      reasoning: "low"
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    check("ap run preflight: missing sandbox credential stops the run",
      run.status !== 0 && run.timedOut === false, {status: run.status, output: output.slice(-1500)});
    check("ap run preflight: error names provider and fix",
      output.includes("AUTH_REQUIRED") && output.includes("provider 'deepseek'")
      && output.includes("opencode auth login"), output.slice(-1500));
    check("ap run preflight: auth list was consulted, no credential was exported",
      readLog(fake.log).includes("AUTH_LIST_CALL")
      && !readLog(fake.log).includes("EXPORT_ARGS="), readLog(fake.log));
    check("ap run preflight: no role was launched and no run artifact was created",
      !output.includes("fake verifier output")
      && !fs.existsSync(path.join(repo, ".autopilot", "runs")),
      output.slice(-1500));
  } finally {
    cleanup(repo, binDir);
  }
}

if (process.platform === "win32") {
  console.log("test-opencode-sandbox-credentials: SKIP live bubblewrap half on Windows");
  if (failures) process.exit(1);
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}

// ── A. v2 + paid provider: export -> import -> private bind -> cleanup ────
{
  const repo = makeFixtureRepo("opencode-creds-a");
  const binDir = makeFixtureBin("opencode-creds-a");
  try {
    const fake = writeFakeOpenCode(binDir, {generation: "2", mode: "pass"});
    configureVerifier(repo, "deepseek/deepseek-flash#low");
    const run = runVerifyFile(repo, binDir);

    const log = readLog(fake.log);
    const exportLines = log.split(/\r?\n/).filter((line) => line.startsWith("EXPORT_ARGS="));
    check("v2 paid: export is called for exactly this provider",
      exportLines.length === 1 && exportLines[0] === "EXPORT_ARGS=auth export deepseek", exportLines);
    const imported = parseImport(log);
    check("v2 paid: import received the export bytes on stdin",
      imported.stdin === fakeExport2, imported.stdin);
    check("v2 paid: import is standalone (never the shared 49374 service)",
      imported.args === "auth import --standalone", imported);
    check("v2 paid: import runs with XDG_DATA_HOME on a private 0700 dir",
      !!imported.xdg && imported.mode === "700", imported);
    check("v2 paid: the data dir is bound at the sandbox data path",
      hasText(path.join(repo, ".autopilot"), "CREDENTIAL_MOUNT_OK"), run.output.slice(-1500));
    check("v2 paid: the temporary private dir is removed after the run",
      !!imported.xdg && !fs.existsSync(imported.xdg), imported.xdg);
    check("v2 paid: the fake secret appears in no run/log/state artifact written by the run",
      secretOccurrences(repo).length === 0, secretOccurrences(repo));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── B. v2 built-in provider / v1: no export/import, no data-dir mount ─────
{
  const repo = makeFixtureRepo("opencode-creds-b2");
  const binDir = makeFixtureBin("opencode-creds-b2");
  try {
    const fake = writeFakeOpenCode(binDir, {generation: "2", mode: "pass"});
    configureVerifier(repo, "opencode/deepseek-v4.1-flash-free");
    runVerifyFile(repo, binDir);
    const log = readLog(fake.log);
    check("v2 free: no export/import is issued",
      !log.includes("EXPORT_ARGS=") && !log.includes("IMPORT_XDG="), log);
    check("v2 free: no credential data dir is mounted",
      hasText(path.join(repo, ".autopilot"), "CREDENTIAL_MOUNT_MISSING")
      && !hasText(path.join(repo, ".autopilot"), "CREDENTIAL_MOUNT_OK"));
  } finally {
    cleanup(repo, binDir);
  }
}
{
  const repo = makeFixtureRepo("opencode-creds-b1");
  const binDir = makeFixtureBin("opencode-creds-b1");
  try {
    const fake = writeFakeOpenCode(binDir, {generation: "1", mode: "pass"});
    configureVerifier(repo, "deepseek/deepseek-flash");
    runVerifyFile(repo, binDir);
    const log = readLog(fake.log);
    check("v1: no export/import is issued (auth.json path unchanged)",
      !log.includes("EXPORT_ARGS=") && !log.includes("IMPORT_XDG="), log);
    check("v1: no credential data dir is mounted",
      hasText(path.join(repo, ".autopilot"), "CREDENTIAL_MOUNT_MISSING")
      && !hasText(path.join(repo, ".autopilot"), "CREDENTIAL_MOUNT_OK"));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── A2. The envelope accepts the credential mount at the exact data path ──
{
  const repo = makeFixtureRepo("opencode-creds-envelope");
  const scratch = fs.mkdtempSync(path.join(temporaryRoot, "scratch-"));
  const dataRoot = fs.mkdtempSync(path.join(temporaryRoot, "data-"));
  const dataDir = path.join(dataRoot, "opencode");
  fs.mkdirSync(dataDir, {recursive: true});
  try {
    const envelope = buildExecutionEnvelope({
      repo, scratchDir: scratch, readOnly: true, config: {},
      binary: process.execPath, args: ["--version"],
      credentialDataMounts: [{host: dataDir, sandbox: sandboxDataPath}]
    });
    check("envelope: credential data mount is a writable bind at the data path",
      envelope.available === true
      && envelope.args.includes("--bind")
      && envelope.args.includes(dataDir)
      && envelope.args.includes(sandboxDataPath)
      && envelope.sandbox?.credentialData?.[0]?.sandbox === sandboxDataPath,
      envelope.reason || envelope.args?.slice(-10));
  } finally {
    cleanup(repo);
    fs.rmSync(scratch, {recursive: true, force: true});
    fs.rmSync(dataRoot, {recursive: true, force: true});
  }
}

// ── C. Export failure / no credential -> AUTH_REQUIRED before launch ──────
for (const mode of ["export-fail", "no-credential"]) {
  const repo = makeFixtureRepo(`opencode-creds-c-${mode}`);
  const binDir = makeFixtureBin(`opencode-creds-c-${mode}`);
  try {
    writeFakeOpenCode(binDir, {generation: "2", mode});
    configureVerifier(repo, "deepseek/deepseek-flash#low");
    const run = runVerifyFile(repo, binDir);
    check(`${mode}: run fails before launch`, run.status !== 0 && run.timedOut === false,
      {status: run.status, output: run.output.slice(-1500)});
    check(`${mode}: AUTH_REQUIRED names the provider and the fix`,
      run.output.includes("AUTH_REQUIRED") && run.output.includes("deepseek")
      && run.output.includes("opencode auth login"), run.output.slice(-1500));
    check(`${mode}: no secret is printed`,
      !run.output.includes(FAKE_SECRET), run.output.slice(-1500));
    check(`${mode}: no role process was launched`,
      !hasText(path.join(repo, ".autopilot"), "CREDENTIAL_MOUNT_OK")
      && !hasText(path.join(repo, ".autopilot"), "fake verifier output"));
  } finally {
    cleanup(repo, binDir);
  }
}

// ── E. Implementer imports into its per-task session store ─────────────────
{
  const binDir = makeFixtureBin("opencode-creds-e");
  const store = fs.mkdtempSync(path.join(temporaryRoot, "session-store-"));
  try {
    const fake = writeFakeOpenCode(binDir, {generation: "2", mode: "pass"});
    check("implementer: session-store mount resolves to its host dir",
      openCodeCredentialDataRoot({
        sessionStoreMounts: [{host: store, sandbox: sandboxDataPath}],
        sandboxDataPath
      }) === store);
    const prepared = await prepareOpenCodeSandboxCredentials({
      adapter: fake.adapter,
      adapterId: "opencode",
      model: "deepseek/deepseek-flash#low",
      sandboxDataPath,
      existingDataRoot: store
    });
    const imported = parseImport(readLog(fake.log));
    check("implementer: import uses the session-store dir as XDG_DATA_HOME",
      prepared && prepared.temporary === false && imported.xdg === store
      && prepared.xdgRoot === store, {prepared, imported});
    check("implementer: the single data dir is the session store's opencode dir",
      prepared?.dataDir === path.join(store, "opencode")
      && prepared?.mount?.host === path.join(store, "opencode")
      && prepared?.mount?.sandbox === sandboxDataPath
      && fs.existsSync(path.join(store, "opencode", "opencode.db")), prepared);
    prepared?.cleanup();
    check("implementer: cleanup never removes the persistent session store",
      fs.existsSync(store) && fs.existsSync(path.join(store, "opencode", "opencode.db")));
  } finally {
    cleanup(binDir);
    fs.rmSync(store, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} sandbox-credential check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
