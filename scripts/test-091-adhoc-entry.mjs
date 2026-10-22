#!/usr/bin/env node
// Mission 091 task 2.1: runAdhocReview entry coverage.
// Accept: relay invoked with persistState:false and parent adhoc dir whose
// nested NN-<role>-<id8>/ subdir holds relay artifacts; .autopilot/state.json
// untouched; .autopilot/runs/ is not created.
// Run: node scripts/test-091-adhoc-entry.mjs
//
// scripts/autopilot.mjs runs main() on import, so this test never imports it:
// static pins over the source plus isolated runs of the extracted
// runAdhocReview/runDirFor functions (brace-matched out of the source) driven
// with a stubbed relay. Fixtures live under $TMPDIR, outside the project repo.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { matchClose } from "./test-fixtures/source-scan.mjs";

let failed = 0;
let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      () => console.log(`PASS ${name}`),
      (e) => { failed++; console.log(`FAIL ${name} :: ${e?.message || String(e)}`); },
    );
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} :: ${e?.message || String(e)}`);
  }
};

const autopilotPath = path.join(process.cwd(), "scripts", "autopilot.mjs");
const src = fs.readFileSync(autopilotPath, "utf8");

// Brace-matched extraction of a top-level `... function NAME(...) { ... }`
// block. The parameter list is skipped first via paren counting: starting the
// brace scan at the first "{" would stop inside destructured params
// (e.g. `function f({a}={})`), truncating the block.
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${name} not found in autopilot.mjs`);
  const parenStart = source.indexOf("(", start);
  assert.ok(parenStart !== -1, `${name} has no parameter list`);
  let pdepth = 0;
  let paramsEnd = -1;
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === "(") pdepth++;
    else if (source[i] === ")") {
      pdepth--;
      if (pdepth === 0) { paramsEnd = i; break; }
    }
  }
  assert.ok(paramsEnd !== -1, `${name} has unterminated parameter list`);
  const bodyStart = source.indexOf("{", paramsEnd);
  assert.ok(bodyStart !== -1, `${name} has no body`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

// --- Static pins -----------------------------------------------------------

check("runAdhocReview is exported from autopilot.mjs", () => {
  assert.ok(src.includes("export async function runAdhocReview("), "missing exported entry");
});

const entrySrc = extractFunction(src, "runAdhocReview");

check("entry calls runRelay with persistState:false + adhoc cwd/runsDir", () => {
  assert.ok(entrySrc.includes("runRelay("), "entry must call runRelay");
  assert.ok(entrySrc.includes("persistState:false"), "relay must be invoked with persistState:false");
  assert.ok(entrySrc.includes("cwd:repoRoot||repo"), "relay cwd must be the real repo root, not the adhoc output dir");
  assert.ok(entrySrc.includes("const s={__adhocRunsDir:parent}"), "runs dir override must be the parent adhoc dir, carried on the synthetic state");
});

check("entry uses synthetic in-memory state, read-only, throwing fatal", () => {
  assert.ok(entrySrc.includes("const s={__adhocRunsDir:parent}"), "entry must build a synthetic in-memory state object");
  assert.ok(entrySrc.includes("readOnly:true"), "read-only safety must be set");
  assert.ok(entrySrc.includes("review:true"), "reviewer verdict parsing must be enabled");
  assert.ok(/fatal:\(message\)=>\{throw new Error\(message\);?\}/.test(entrySrc) || /fatal:orchestratorFatal\b/.test(entrySrc), "fatal must throw (inline Error or orchestratorFatal), never exit");
  assert.ok(!/fatal:[^,}]*process\.exit/.test(entrySrc), "fatal must never exit");
  assert.ok(!entrySrc.includes("saveState"), "entry must never touch state persistence directly");
  assert.ok(!entrySrc.includes("process.on("), "entry must not install exit hooks");
  assert.ok(!entrySrc.includes("die("), "entry must never call die()");
});

check("runRelay/runDirFor text unchanged; runsDirFor honors the synthetic-state override", () => {
  // The static gate tests anchor on this exact call text, so the adhoc runs
  // dir travels on the in-memory state instead of a new runDirFor argument.
  assert.ok(src.includes("{dir,mission}=runDirFor(s,id,roleName)"), "runRelay must keep the exact runDirFor call");
  assert.ok(src.includes("function runDirFor(s,id,roleName){"), "runDirFor signature must be unchanged");
  const fnSrc = extractFunction(src, "runsDirFor");
  assert.ok(fnSrc.includes("s.__adhocRunsDir"), "runsDirFor must honor the adhoc override");
});

check("existing relay/relayAsync signatures unchanged", () => {
  assert.ok(src.includes("function relay(roleName,task,c,s,options={}){"), "relay() signature must be unchanged");
  const raStart = src.indexOf("async function relayAsync(roleName,task,c,s,options={}){");
  assert.ok(raStart !== -1, "relayAsync() signature must be unchanged");
  const dOpen = src.indexOf("const {", raStart);
  const dEnd = dOpen === -1 ? -1 : matchClose(src, dOpen + "const ".length);
  assert.ok(dOpen !== -1 && dEnd !== -1 && src.slice(dEnd + 1, dEnd + 10) === "=options;", "relayAsync() must destructure its options");
  // Top-level split (defaults like taskFacts={} / requirements=[] hold no commas).
  const names = src.slice(dOpen + 7, dEnd).split(",").map((p) => p.split("=")[0].trim());
  for (const n of ["cwd", "readOnly", "resume", "review", "persistState", "requirements", "taskFacts", "taskRef", "timeoutMs", "capEnabled", "contScope", "planRevision", "carriedForwardTasks"]) {
    assert.ok(names.includes(n), `relayAsync() options must include ${n} (Phase 2 fields: contScope, planRevision, carriedForwardTasks)`);
  }
});

check("no exit hook added to entry; whole-file allows one exit-refresh hook", () => {
  assert.ok(!entrySrc.includes("process.on("), "entry must not install process hooks");
  // Whole-file pin: the three signal hooks (SIGTERM, SIGINT, SIGHUP) installed
  // by installInterruptFlush plus exactly one exit hook that only refreshes
  // the report.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    assert.ok(new RegExp(`process\\.on\\(\\s*["']${sig}["']`).test(src), `missing ${sig} signal hook`);
  }
  const signalHooks = src.match(/process\.on\(\s*["']SIG(?:TERM|INT|HUP)["']/g) || [];
  assert.equal(signalHooks.length, 3, `expected 3 signal hooks (SIGTERM, SIGINT, SIGHUP) (got ${signalHooks.length})`);
  const hooks = src.match(/process\.on\(/g) || [];
  assert.equal(hooks.length, 4, `expected 3 signal hooks + 1 exit-refresh hook (got ${hooks.length})`);
  const exitHooks = src.match(/process\.on\s*\(\s*["']exit["']\s*,.*?\);/gs) || [];
  assert.equal(exitHooks.length, 1, "must have exactly one exit hook");
  assert.ok(/refreshWatchReport/.test(exitHooks[0]), "exit hook must only refresh the report");
});

check("autopilot.mjs parses (node --check)", () => {
  const r = spawnSync(process.execPath, ["--check", autopilotPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr || ""}`);
});

// --- Isolated functional runs ----------------------------------------------
// Fixtures live under $TMPDIR, outside the project repo.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-entry-"));
const parent = path.join(root, ".autopilot", "adhoc", "20260101T000000-plan_reviewer");
fs.mkdirSync(parent, { recursive: true });
// Sentinel state: the entry must leave it byte-identical.
const statePath = path.join(root, ".autopilot", "state.json");
fs.writeFileSync(statePath, JSON.stringify({ sentinel: "untouched" }), "utf8");
const stateBefore = fs.readFileSync(statePath, "utf8");

let seq = 0;
const stubCalls = [];
function makeStub() {
  return (roleName, task, c, s, options) => {
    stubCalls.push({ roleName, task, c, s, options });
    // Mimic production naming: NN-<role>-<id8> nested inside runsDir.
    seq += 1;
    const role = String(roleName).replace(/[^A-Za-z0-9_]/g, "_");
    const nested = path.join(String(s.__adhocRunsDir), `${String(seq).padStart(2, "0")}-${role}-a1b2c3d4`);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "status.json"), JSON.stringify({ role: roleName }), "utf8");
    fs.writeFileSync(path.join(nested, "result.json"), JSON.stringify({ verdict: "PASS" }), "utf8");
    return { stubbed: true, nested };
  };
}

async function runEntry(args, stub) {
  const harnessed = entrySrc
    .replace("function runAdhocReview", "async function __adhocReview")
    .replace(/runRelay\(/g, "__stubRunRelay(");
  const code = `${harnessed}\nreturn await __adhocReview(__args);`;
  const context = vm.createContext({
    __stubRunRelay: stub, __args: args, fs, path,
  });
  // Provide the real orchestratorFatal (a throwing helper) to the sandbox.
  vm.runInContext(extractFunction(src, "orchestratorFatal"), context);
  return vm.runInContext(`(async () => { ${code} })()`, context);
}

const config = { roles: { plan_reviewer: { adapter: "fake" } } };
const prompt = "Review the plan for gaps.";

await check("entry invokes stubbed relay with persistState:false + parent adhoc dir", async () => {
  const stub = makeStub();
  const res = await runEntry({ role: "plan_reviewer", prompt, adhocDir: parent, repoRoot: root, config }, stub);
  assert.equal(res.stubbed, true);
  assert.equal(stubCalls.length, 1);
  const call = stubCalls[0];
  assert.equal(call.roleName, "plan_reviewer");
  assert.equal(call.task, prompt);
  assert.equal(call.options.persistState, false);
  assert.equal(call.options.cwd, root, "relay cwd must be the real repo root");
  assert.notEqual(call.options.cwd, parent, "relay cwd must NOT be the adhoc output dir");
  assert.equal(call.s.__adhocRunsDir, parent);
  assert.equal("runsDir" in call.options, false);
  assert.equal(call.options.readOnly, true);
  assert.equal(call.options.alwaysSave, false);
  assert.deepEqual(call.s, { __adhocRunsDir: parent }, "state must be a fresh synthetic in-memory object");
  assert.throws(() => call.options.fatal("boom"), /boom/, "fatal must throw instead of exiting");
});

await check("nested NN-<role>-<id8>/ subdir holds relay artifacts", async () => {
  const entries = fs.readdirSync(parent);
  assert.equal(entries.length, 1, `parent must hold exactly the nested run dir (got ${entries})`);
  assert.match(entries[0], /^\d{2,}-plan_reviewer-[0-9a-fA-F]{8}$/, "nested dir must match NN-<role>-<id8>");
  const nested = path.join(parent, entries[0]);
  assert.ok(fs.existsSync(path.join(nested, "status.json")), "relay status artifact must exist");
  assert.ok(fs.existsSync(path.join(nested, "result.json")), "relay result artifact must exist");
});

check("state.json untouched; .autopilot/runs/ not created", () => {
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore, "state.json must be byte-identical");
  assert.equal(fs.existsSync(path.join(root, ".autopilot", "runs")), false, ".autopilot/runs/ must not be created");
});

await check("entry refuses missing/relative/unreadable inputs", async () => {
  const never = () => { throw new Error("relay must not be called on refusal paths"); };
  await assert.rejects(runEntry({ role: "", prompt, adhocDir: parent, config }, never), /role is required/);
  await assert.rejects(runEntry({ role: "plan_reviewer", prompt: "  ", adhocDir: parent, config }, never), /prompt is required/);
  await assert.rejects(runEntry({ role: "plan_reviewer", prompt, adhocDir: "relative/dir", config }, never), /absolute path/);
  await assert.rejects(runEntry({ role: "plan_reviewer", prompt, adhocDir: path.join(root, "nope"), config }, never), /not found/);
  await assert.rejects(runEntry({ role: "plan_reviewer", prompt, adhocDir: parent, config: { roles: {} } }, never), /missing role/);
});

check("runDirFor nests under s.__adhocRunsDir while default keeps current base", () => {
  const fnSrc = extractFunction(src, "runDirFor");
  const rdSrc = extractFunction(src, "runsDirFor");
  let n = 0;
  const sandbox = {
    path,
    repo: root,
    __parent: parent,
    missionDirFor: () => null,
    nextRunSeq: () => { n += 1; return n; },
  };
  vm.createContext(sandbox);
  const defaultBase = path.join(root, ".autopilot", "runs");
  const code = `${rdSrc}\n${fnSrc}\n[runDirFor({__adhocRunsDir: __parent}, "a1b2c3d4e5f6", "plan_reviewer"), runDirFor({}, "a1b2c3d4e5f6", "plan_reviewer")];`;
  const [overridden, current] = vm.runInContext(code, sandbox);
  assert.equal(overridden.mission, null);
  assert.equal(path.dirname(overridden.dir), parent, "override must nest inside the parent adhoc dir");
  assert.match(path.basename(overridden.dir), /^\d{2,}-plan_reviewer-[0-9a-fA-F]{8}$/);
  assert.equal(path.dirname(current.dir), defaultBase, "no override must keep the current base");
  assert.match(path.basename(current.dir), /^\d{2,}-plan_reviewer-[0-9a-fA-F]{8}$/);
});

check("CLI entry guarded: importing autopilot.mjs runs no main() (realpath entry check)", () => {
  assert.ok(src.includes("import.meta.url"), "autopilot.mjs must gate CLI startup on import.meta.url");
  assert.ok(src.includes("fileURLToPath(import.meta.url)"), "gate must resolve the module path via fileURLToPath");
  assert.ok(src.includes("fs.realpathSync(process.argv[1])"), "gate must resolve argv[1] through symlinks via realpath");
  assert.ok(src.includes("if(__isMainEntry)"), "main() must only run for the direct entry");
});

await check("CLI runs through a symlinked path (unknown command exits non-zero)", async () => {
  // Symlinked invocation must still be detected as the main entry: run the
  // real script via a symlink in a temp dir with an unknown command and
  // assert it dies non-zero (usage error) instead of silently exiting 0.
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-entry-symlink-"));
  const linkDir = path.join(linkRoot, "linkrepo", "scripts");
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(autopilotPath, path.join(linkDir, "autopilot.mjs"));
  const r = spawnSync(process.execPath, [path.join(linkDir, "autopilot.mjs"), "bogus-cmd-091"], { cwd: linkRoot, encoding: "utf8", timeout: 120000 });
  assert.notEqual(r.status, 0, `symlinked CLI must exit non-zero (got ${r.status}): stdout=${r.stdout || ""} stderr=${String(r.stderr || "").slice(0, 2000)}`);
});

await check("real import has no side effects (config/state untouched, no runs dir)", async () => {
  // Import the real module in a child process whose argv mimics
  // `ap plan-review PLAN.md` (previously ran main() -> config migration +
  // exit 2 via defaultEntry's dynamic import). Fixtures live under $TMPDIR.
  const fixRoot = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-entry-import-"));
  const fixAuto = path.join(fixRoot, ".autopilot");
  fs.mkdirSync(fixAuto, { recursive: true });
  const cfgSentinel = JSON.stringify({ version: 1, sentinel: "cfg-untouched" });
  const stateSentinel = JSON.stringify({ sentinel: "state-untouched" });
  fs.writeFileSync(path.join(fixAuto, "config.json"), cfgSentinel, "utf8");
  fs.writeFileSync(path.join(fixAuto, "state.json"), stateSentinel, "utf8");
  const autopilotUrl = new URL(`file://${autopilotPath}`).href;
  const probe = path.join(fixRoot, "probe.mjs");
  fs.writeFileSync(probe,
    `import(${JSON.stringify(autopilotUrl)}).then(m=>{` +
    `if(typeof m.runAdhocReview!=="function"){console.error("missing runAdhocReview");process.exit(3);}` +
    `console.log("import-ok");}).catch(e=>{console.error("import-fail",e?.stack||e);process.exit(4);});`,
    "utf8");
  const r = spawnSync(process.execPath, [probe, "plan-review", "PLAN.md"], { cwd: fixRoot, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `import probe must exit 0 (got ${r.status}): stdout=${r.stdout || ""} stderr=${String(r.stderr || "").slice(0, 2000)}`);
  assert.match(String(r.stdout || ""), /import-ok/, "probe must reach runAdhocReview export");
  assert.equal(fs.readFileSync(path.join(fixAuto, "config.json"), "utf8"), cfgSentinel, "config.json must be byte-identical");
  assert.equal(fs.readFileSync(path.join(fixAuto, "state.json"), "utf8"), stateSentinel, "state.json must be byte-identical");
  assert.equal(fs.existsSync(path.join(fixAuto, "runs")), false, ".autopilot/runs/ must not be created");
});

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
