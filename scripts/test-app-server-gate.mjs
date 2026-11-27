#!/usr/bin/env node
// Backlog #3: the gate starts the configured app server, runs the gate
// commands against it, and always stops it. The real gates() from
// autopilot.mjs runs in a child process (test-fixtures/app-server-gate-driver)
// against a throwaway repo and the tiny fixture server.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {parseEnvFile, maskSecrets, appServerConfig, isPortFree} from "./app-server.mjs";
import {validateAppServerConfig} from "./config-validation.mjs";
import {detectAppServerCommand, resolveAppServerAnswer, parsePathList, normalizeReadyUrl} from "./app-server-setup.mjs";
import {toRuntimeConfig, toNewLayoutConfig, DEFAULTS} from "./config-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const FIXTURE = path.join(here, "test-fixtures", "fake-app-server.mjs");
const DRIVER = path.join(here, "test-fixtures", "app-server-gate-driver.mjs");
const SECRET = "s3cr3t-MARKER-9f2a71c4";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runGate({appServer, command = "node -e \"fetch(process.env.APP_BASE_URL+'/hello').then(r=>console.log('GATE-STATUS',r.status,process.env.PORT===new URL(process.env.APP_BASE_URL).port))\"", envFileText, fixtureEnv = {}}) {
  const repo = tmp("autopilot-appsrv-repo-");
  const work = tmp("autopilot-appsrv-work-");
  spawnSync("git", ["init", "-q", repo]);
  if (envFileText !== undefined) fs.writeFileSync(path.join(repo, ".env.test"), envFileText);
  const reqLog = path.join(work, "requests.log");
  const stateFile = path.join(work, "state.json");
  const cfg = {
    gates: {
      commands: [command],
      network_isolation: true,
      app_server: {
        start_command: `node ${JSON.stringify(FIXTURE)}`,
        port: "auto",
        ready_url: "/ready",
        warmup_urls: ["/warm-a", "/warm-b"],
        ready_timeout_ms: 20000,
        env: {FIXTURE_REQUEST_LOG: reqLog, FIXTURE_STATE_FILE: stateFile, FIXTURE_DELAY_MS: "700", ...fixtureEnv},
        ...appServer,
      },
    },
  };
  const cfgFile = path.join(work, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [DRIVER, cfgFile], {cwd: repo, encoding: "utf8", timeout: 90000});
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
  const result = line ? JSON.parse(line.slice(7)) : null;
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
  const requests = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, "utf8").split("\n").filter(Boolean) : [];
  return {repo, work, result, state, requests, stdout: r.stdout || "", stderr: r.stderr || "", status: r.status};
}

function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

// --- 1. happy path through the real gate --------------------------------
console.log("gate: server started, ready polled, warm-up, command fetches it, server stopped");
{
  const g = runGate({});
  check("gate passed", g.result?.ok === true, {result: g.result, stderr: g.stderr.slice(-400)});
  const log = g.result?.logFile && fs.existsSync(g.result.logFile) ? fs.readFileSync(g.result.logFile, "utf8") : "";
  check("gate command saw APP_BASE_URL and fetched the server (200, PORT matches)", /GATE-STATUS 200 true/.test(log), log.slice(-300));
  check("ready path was polled more than once (server answered 503 first)", g.requests.filter((p) => p === "/ready").length >= 2, g.requests);
  const iWarmA = g.requests.indexOf("/warm-a");
  const iWarmB = g.requests.indexOf("/warm-b");
  const lastReady = g.requests.lastIndexOf("/ready");
  check("each warm-up url requested exactly once, after ready, in order",
    g.requests.filter((p) => p === "/warm-a").length === 1 && g.requests.filter((p) => p === "/warm-b").length === 1 && lastReady < iWarmA && iWarmA < iWarmB, g.requests);
  check("gate command request came after the warm-up", g.requests.indexOf("/hello") > iWarmB, g.requests);
  const port = Number(g.state?.port);
  check("auto port was a real port", Number.isInteger(port) && port > 0);
  check("server process is gone after the gate", g.state && !alive(g.state.pid));
  check("port is free after the gate", await isPortFree(port));
  check("log notes the stop", /\[app-server\] stopped \(port \d+ free[,)]/.test(g.stdout), g.stdout.slice(-500));
}

// --- 2. gate command failure still stops the server -----------------------
console.log("gate: failing command still stops the server");
{
  const g = runGate({command: "exit 1"});
  check("gate failed", g.result?.ok === false && g.result?.command === "exit 1", g.result);
  check("server stopped anyway", g.state && !alive(g.state.pid));
  check("port free", await isPortFree(Number(g.state?.port)));
}

// --- 3. ready timeout -> clear failure, server killed --------------------
console.log("gate: ready timeout");
{
  const g = runGate({appServer: {ready_timeout_ms: 1500}, fixtureEnv: {FIXTURE_MODE: "never-ready"}});
  check("gate failed on the app server", g.result?.ok === false && g.result?.command === "app_server.start_command" && g.result?.reason === "app-server-start-failed", g.result);
  check("message says not ready after the timeout", /not ready after 2s|not ready after 1s|not ready after/.test(g.result?.tail || ""), g.result?.tail);
  check("server output is attached", /fixture listening on \d+/.test(g.result?.tail || ""), g.result?.tail);
  check("gate command never ran", !g.requests.includes("/hello"));
  check("server killed after the timeout", g.state && !alive(g.state.pid));
  check("port free after the timeout", await isPortFree(Number(g.state?.port)));
}

// --- 4. start command exits at once -> clear failure ----------------------
console.log("gate: start command exits immediately");
{
  const started = Date.now();
  const g = runGate({fixtureEnv: {FIXTURE_MODE: "exit"}});
  check("gate failed on the app server", g.result?.ok === false && g.result?.command === "app_server.start_command", g.result);
  check("message says it exited before ready with code 3", /exited before it was ready \(code 3\)/.test(g.result?.tail || ""), g.result?.tail);
  check("output of the failing server is attached", /failing on purpose/.test(g.result?.tail || ""), g.result?.tail);
  check("failed fast, no hang until the ready timeout", Date.now() - started < 30000);
  check("no request ever reached a server", g.requests.length === 0);
}

// --- 5. secrets from env_file ---------------------------------------------
console.log("gate: env_file secrets reach the server only");
{
  const g = runGate({
    appServer: {env_file: ".env.test"},
    envFileText: `# comment\nexport APP_SECRET="${SECRET}"\nOTHER=plain\n`,
    command: "node -e \"console.log('GATE-SEES-SECRET', process.env.APP_SECRET !== undefined)\"",
  });
  check("gate passed", g.result?.ok === true, g.result);
  const sha = crypto.createHash("sha256").update(SECRET).digest("hex");
  check("server process received the env_file value", g.state?.secretSha === sha, g.state);
  const log = fs.readFileSync(g.result.logFile, "utf8");
  check("gate command did NOT receive the env_file value", /GATE-SEES-SECRET false/.test(log), log);
  const leaked = [...filesUnder(path.join(g.repo, ".autopilot"))].filter((f) => fs.readFileSync(f, "utf8").includes(SECRET));
  check("marker not in any .autopilot file (gate logs, state, runs)", leaked.length === 0, leaked);
  check("marker not in the orchestrator output", !g.stdout.includes(SECRET) && !g.stderr.includes(SECRET));

  const f = runGate({
    appServer: {env_file: ".env.test", ready_timeout_ms: 1500},
    envFileText: `APP_SECRET=${SECRET}\n`,
    fixtureEnv: {FIXTURE_MODE: "never-ready", FIXTURE_ECHO_SECRET: "1"},
  });
  check("failure: server printed the secret, tail shows the variable NAME instead", (f.result?.tail || "").includes("<APP_SECRET>") && !(f.result?.tail || "").includes(SECRET), f.result?.tail);
  const leaked2 = filesUnder(path.join(f.repo, ".autopilot")).filter((p) => fs.readFileSync(p, "utf8").includes(SECRET));
  check("failure: marker not in any written file", leaked2.length === 0, leaked2);
  check("failure: marker not in the result or output", !JSON.stringify(f.result).includes(SECRET) && !f.stdout.includes(SECRET) && !f.stderr.includes(SECRET));
  check("failure: server killed", f.state && !alive(f.state.pid));

  const missing = runGate({appServer: {env_file: "no-such.env"}});
  check("missing env_file is a clear failure naming the file, not a hang", missing.result?.ok === false && /env_file no-such\.env cannot be read/.test(missing.result?.tail || ""), missing.result);
}

// --- 6. an off block changes nothing --------------------------------------
console.log("gate: no start_command = old behaviour");
{
  const g = runGate({appServer: {start_command: ""}, command: "node -e \"console.log('NO-SERVER', process.env.APP_BASE_URL === undefined)\""});
  check("gate passed without a server and without APP_BASE_URL", g.result?.ok === true && /NO-SERVER true/.test(fs.readFileSync(g.result.logFile, "utf8")), g.result);
  check("no server was started", g.state === null);
}

// --- 7. SIGTERM of the orchestrator stops the server ----------------------
console.log("gate: orchestrator SIGTERM stops the server");
{
  const g = (() => {
    const repo = tmp("autopilot-appsrv-sig-");
    const work = tmp("autopilot-appsrv-sigw-");
    spawnSync("git", ["init", "-q", repo]);
    const stateFile = path.join(work, "state.json");
    const cfgFile = path.join(work, "config.json");
    fs.writeFileSync(cfgFile, JSON.stringify({gates: {commands: ["sleep 60"], network_isolation: true, app_server: {
      start_command: `node ${JSON.stringify(FIXTURE)}`, ready_url: "/", ready_timeout_ms: 20000, env: {FIXTURE_STATE_FILE: stateFile},
    }}}));
    return {repo, stateFile, cfgFile};
  })();
  const child = spawn(process.execPath, [DRIVER, g.cfgFile], {cwd: g.repo, stdio: "ignore"});
  let st = null;
  for (let i = 0; i < 100 && !st; i++) {
    await sleep(200);
    try { st = JSON.parse(fs.readFileSync(g.stateFile, "utf8")); } catch {}
  }
  await sleep(1500); // let the gate reach "sleep 60"
  const serverUp = st && alive(st.pid);
  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
  await sleep(500);
  check("server was running while the gate command ran", !!serverUp);
  check("server gone after SIGTERM to the orchestrator", st && !alive(st.pid));
  check("port free after SIGTERM", st && await isPortFree(Number(st.port)));
}

// --- 8. pure helpers -------------------------------------------------------
console.log("helpers");
{
  const env = parseEnvFile(`# c\nA=1\nexport B="two words"\nC='x y'\nD=val # trailing\nbad line\n`);
  check("parseEnvFile handles export, quotes, comments", env.A === "1" && env.B === "two words" && env.C === "x y" && env.D === "val" && Object.keys(env).length === 4, env);
  check("maskSecrets replaces values by NAME", maskSecrets("token=abcd1234 and abcd1234", {TOKEN: "abcd1234"}) === "token=<TOKEN> and <TOKEN>");
  check("maskSecrets leaves very short values alone", maskSecrets("a=1", {A: "1"}) === "a=1");
  check("appServerConfig is null for an empty or missing block", appServerConfig({gates: {app_server: {start_command: "  "}}}) === null && appServerConfig({}) === null);
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => resolve(s)); });
  check("isPortFree is false for a busy port", !(await isPortFree(port.address().port)));
  port.close();
}

// --- 9. config: validation, layout round trip, schema, docs ----------------
console.log("config");
{
  const errs = (block) => { const e = []; validateAppServerConfig(block, "tests.app_server", e); return e; };
  check("default block validates", errs(DEFAULTS.tests.app_server).length === 0, errs(DEFAULTS.tests.app_server));
  check("numeric port and options validate", errs({start_command: "npm run dev", port: 3100, ready_url: "/ar/login", warmup_urls: ["/a"], ready_timeout_ms: 60000, env_file: "apps/web/.env.local", env: {A: "b"}, cwd: "apps/web"}).length === 0);
  check("bad port rejected", errs({port: 0}).length === 1 && errs({port: "x"}).length === 1);
  check("cwd with .. rejected", errs({cwd: "../x"}).length === 1);
  check("absolute env_file rejected", errs({env_file: "/etc/passwd"}).length === 1);
  check("ready_url must start with /", errs({ready_url: "login"}).length === 1);
  check("warmup url must start with /", errs({warmup_urls: ["a"]}).length === 1);
  check("ready_timeout_ms minimum 1000", errs({ready_timeout_ms: 5}).length === 1);
  check("non-string env value rejected", errs({env: {A: 1}}).length === 1);
  check("credential_vars array of valid variable names validates", errs({credential_vars: ["E2E_LOGIN", "TEST_PASS"]}).length === 0);
  check("non-array credential_vars rejected", errs({credential_vars: "E2E_LOGIN"}).length === 1);
  check("invalid variable name in credential_vars rejected", errs({credential_vars: ["123_BAD"]}).length === 1);
  check("unknown key rejected", errs({bogus: 1}).length === 1);
  const layout = {tests: {app_server: {start_command: "npm run dev", ready_url: "/x"}}};
  const runtime = toRuntimeConfig(layout);
  check("layout tests.app_server maps to gates.app_server", runtime.gates?.app_server?.start_command === "npm run dev", runtime.gates);
  const back = toNewLayoutConfig({gates: {commands: [], app_server: {start_command: "npm run dev", ready_url: "/x"}}});
  check("runtime gates.app_server maps back to tests.app_server", back.tests?.app_server?.start_command === "npm run dev", back.tests);
  const schema = JSON.parse(fs.readFileSync(path.join(root, "config.schema.json"), "utf8"));
  const props = schema.properties.tests.properties.app_server?.properties || {};
  check("schema lists every app_server key with a description", ["start_command", "cwd", "port", "ready_url", "warmup_urls", "ready_timeout_ms", "env_file", "env", "allow_hosts", "credential_vars"].every((k) => props[k]?.description), Object.keys(props));
  const docs = fs.readFileSync(path.join(root, "docs", "configuration.md"), "utf8");
  check("docs/configuration.md documents every tests.app_server key", ["start_command", "cwd", "port", "ready_url", "warmup_urls", "ready_timeout_ms", "env_file", "env", "allow_hosts", "credential_vars"].every((k) => docs.includes(`\`tests.app_server.${k}\``)));
  const example = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  check("config.example.json carries the off-by-default block", example.tests.app_server?.start_command === "");
}

// --- 10. setup / config question -------------------------------------------
console.log("setup and config question");
{
  const dir = tmp("autopilot-appsrv-det-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({scripts: {dev: "next dev", start: "next start"}}));
  check("detects npm run dev from package.json", detectAppServerCommand(dir)?.start_command === "npm run dev");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({scripts: {start: "node s.js"}}));
  check("falls back to npm start", detectAppServerCommand(dir)?.start_command === "npm start");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({scripts: {test: "x"}}));
  check("no dev/start script -> nothing detected", detectAppServerCommand(dir) === null);
  const det = {start_command: "npm run dev", cwd: ""};
  check("Enter on a fresh project = no server", resolveAppServerAnswer({answer: "", existing: "", detected: det}).action === "none");
  check("y uses the detected command", resolveAppServerAnswer({answer: "y", existing: "", detected: det}).start_command === "npm run dev");
  check("typed command is used verbatim", resolveAppServerAnswer({answer: "node s.js {port}", existing: "", detected: det}).start_command === "node s.js {port}");
  check("Enter keeps an existing command, - clears it", resolveAppServerAnswer({answer: "", existing: "x", detected: null}).action === "keep" && resolveAppServerAnswer({answer: "-", existing: "x", detected: null}).action === "clear");
  check("path list parsing adds the leading slash", JSON.stringify(parsePathList("login, /a ,")) === JSON.stringify(["/login", "/a"]) && normalizeReadyUrl("") === "/" && normalizeReadyUrl("ar/login") === "/ar/login");

  // The real wizard (same code for `ap setup` first run and `ap config`).
  const binDir = tmp("autopilot-appsrv-bin-");
  const realTrue = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
  fs.copyFileSync(realTrue, path.join(binDir, "claude"));
  fs.chmodSync(path.join(binDir, "claude"), 0o755);
  const role = () => ({adapter: "claude", model: "", reasoning: "", variant: "", resume: true, model_source: "default", model_verified_at: null, capabilities_verified_at: null});
  const makeRepo = (pkgScripts) => {
    const repo = tmp("autopilot-appsrv-wiz-");
    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({name: "x", scripts: pkgScripts}));
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({
      schema_version: "4.0",
      project: {repo: ".", planning_framework: "standalone", state_file: ".autopilot/state.json", runs_dir: ".autopilot/runs"},
      roles: {planner: role(), plan_reviewer: role(), implementer: role(), code_reviewer: role(), verifier: role()},
      workflow: {}, gates: {env_allowlist: [], require_reviewer: true, network_isolation: true, commands: []},
      policy: {failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2}},
      safety: {}, planning: {},
      capabilities: {project_defaults: [], role_requirements: {}, safety_denied: [], legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}},
      config_metadata: {migrated_from: "3.0", last_migrated_at: "2026-01-01T00:00:00.000Z"},
    }, null, 2));
    return repo;
  };
  const runSetup = (repo, answers) => spawnSync(process.execPath, [path.join(here, "setup.mjs"), "--edit", "--repo", repo], {
    cwd: root, encoding: "utf8", timeout: 60000, input: answers.map((a) => `${a}\n`).join(""),
    env: {...process.env, PATH: `${binDir}:/usr/bin:/bin`, AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"},
  });
  const readBlock = (repo) => {
    const c = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8"));
    return c.tests?.app_server ?? c.gates?.app_server;
  };
  // answers: scope "3" (framework/safety), test command "-" (none), allow_docker "" (default No), then the app-server block.
  const repoA = makeRepo({dev: "next dev"});
  const a = runSetup(repoA, ["3", "-", "", "y", "/ar/login", "/ar/login, /ar/home", "apps/web/.env.local"]);
  const outA = a.stdout + a.stderr;
  check("setup shows the app server question with the found command", /App server \(optional\)[\s\S]*Found: npm run dev\nEnter = no app server/.test(outA), outA.slice(-800));
  const blockA = readBlock(repoA);
  check("answers are stored in tests.app_server", blockA?.start_command === "npm run dev" && blockA.ready_url === "/ar/login" && JSON.stringify(blockA.warmup_urls) === JSON.stringify(["/ar/login", "/ar/home"]) && blockA.env_file === "apps/web/.env.local" && blockA.port === "auto", blockA);
  const b = runSetup(repoA, ["3", "-", "", ""]);
  check("config shows the current command and Enter keeps it", /Current: npm run dev\nEnter = keep it/.test(b.stdout) && readBlock(repoA)?.start_command === "npm run dev", b.stdout.slice(-600));
  const c = runSetup(repoA, ["3", "-", "", "-"]);
  check("config: - removes the app server", !readBlock(repoA) || !readBlock(repoA).start_command, readBlock(repoA));
  const repoB = makeRepo({test: "node t.js"});
  const d = runSetup(repoB, ["3", "-", ""]);
  check("no dev/start script: no new question, nothing stored", !/App server \(optional\)/.test(d.stdout) && !readBlock(repoB)?.start_command, d.stdout.slice(-400));
}

for (const d of tmpDirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
