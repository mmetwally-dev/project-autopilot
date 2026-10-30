#!/usr/bin/env node
// Backlog #4 part A: OpenCode 1.x / 2.x support.
//
// 1.x (npm opencode-ai) keeps `run --variant` + `models --verbose`.
// 2.x (npm @opencode/cli) has no --variant: the level is the model suffix
// (`--model provider/model#level`), `models --verbose` is gone (levels come
// from `opencode api GET /api/model`), and every run role needs --standalone
// so an OPENCODE_CONFIG_CONTENT-defined agent (autopilot_readonly) is visible.
//
// The real 2.2.0 help/API captures live in scripts/test-fixtures; fake
// binaries below replay them so the real discovery, invocation, verification
// and setup paths run without a real CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {discoverCapabilities, discoverModelCatalog} from "./model-discovery.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";
import {applyAgentSelections, verifyAgentInvocation} from "./agent-invocation.mjs";
import {validateRoleSelection} from "./config-validation.mjs";
import {generationFromHelp} from "./opencode-generation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtures = path.join(here, "test-fixtures");
const setupScript = path.join(here, "setup.mjs");
const agents = JSON.parse(fs.readFileSync(path.join(root, "adapters", "agents.json"), "utf8")).adapters;
const driver = adapterDriver("opencode");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-opencode-2x-"));
const previousPath = process.env.PATH;
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const systemDirs = process.platform === "win32"
  ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
  : ["/usr/bin", "/bin"];

function pathWith(binDir) {
  return [binDir, ...systemDirs].join(path.delimiter);
}

function makeBin(dir, name, scriptPath) {
  if (process.platform === "win32") {
    const bin = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return bin;
  }
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function writeFakeOpenCode(generation) {
  const dir = fs.mkdtempSync(path.join(scratch, `bin-${generation}x-`));
  const script = path.join(dir, "fake-opencode.mjs");
  const help = path.join(fixtures, `opencode-${generation}x-run-help.txt`);
  const api = path.join(fixtures, "opencode-2x-api-model.json");
  const verbose = path.join(fixtures, "opencode-1x-models-verbose.txt");
  const lines = [
    "import fs from 'node:fs';",
    "const a = process.argv.slice(2);",
    "const out = (text, code = 0) => { process.stdout.write(text); process.exit(code); };",
    `if (a[0] === "--version") out(${JSON.stringify(`opencode ${generation}.0.0`)} + "\\n");`,
    `if (a[0] === "--help") out("Usage: opencode\\n  run [message..]\\n");`,
    `if (a[0] === "run" && a[1] === "--help") out(fs.readFileSync(${JSON.stringify(help)}, "utf8"));`
  ];
  if (generation === "2") {
    lines.push(
      `if (a[0] === "api" && a[1] === "GET" && a[2] === "/api/model") out(fs.readFileSync(${JSON.stringify(api)}, "utf8"));`,
      'if (a[0] === "models" && a[1] === "--verbose") out("ERROR\\n  Unrecognized flag: --verbose\\n", 1);',
      'if (a[0] === "models") out("opencode/big-pickle\\nopencode/deepseek-v4.1-flash-free\\n");'
    );
  } else {
    lines.push(
      `if (a[0] === "models" && a[1] === "--verbose") out(fs.readFileSync(${JSON.stringify(verbose)}, "utf8"));`,
      'if (a[0] === "models") out("opencode/fake-model\\nopencode/another-model\\n");'
    );
  }
  lines.push('out("", 0);');
  fs.writeFileSync(script, lines.join("\n"));
  return {dir, binary: makeBin(dir, "opencode", script)};
}

// A generation-detection fake that logs every launch, so a test can prove
// capability discovery is the only probe: the launch-time callers must read
// the cache it warmed, not spawn the binary again.
function writeCountingFakeOpenCode(generation) {
  const dir = fs.mkdtempSync(path.join(scratch, `bin-count-${generation}-`));
  const script = path.join(dir, "fake-opencode.mjs");
  const counter = path.join(dir, "spawns.txt");
  const help = path.join(fixtures, `opencode-${generation}x-run-help.txt`);
  const lines = [
    "import fs from 'node:fs';",
    `const counter = ${JSON.stringify(counter)};`,
    'try { fs.appendFileSync(counter, "spawn\\n"); } catch {}',
    "const a = process.argv.slice(2);",
    "const out = (text, code = 0) => { process.stdout.write(text); process.exit(code); };",
    `if (a[0] === "--version") out(${JSON.stringify(`opencode ${generation}.0.0`)} + "\\n");`,
    `if (a[0] === "--help") out("Usage: opencode\\n  run [message..]\\n");`,
    `if (a[0] === "run" && a[1] === "--help") out(fs.readFileSync(${JSON.stringify(help)}, "utf8"));`,
    'out("", 0);'
  ];
  fs.writeFileSync(script, lines.join("\n"));
  return {dir, binary: makeBin(dir, "opencode", script), counter};
}

function runSetupSync({binDir, repo, args}) {
  const r = spawnSync(process.execPath, [setupScript, ...args, "--repo", repo], {
    cwd: root,
    env: {
      ...process.env,
      PATH: pathWith(binDir),
      AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"
    },
    input: Array(400).fill("").join("\n"),
    encoding: "utf8",
    timeout: 120000
  });
  return {status: r.status, signal: r.signal, error: r.error, out: `${r.stdout || ""}\n${r.stderr || ""}`};
}

function runSetupInteractively({binDir, repo, args, script, stopAt, timeoutMs = 60000}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupScript, ...args, "--repo", repo], {
      cwd: root,
      env: {...process.env, PATH: pathWith(binDir)},
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let scriptIndex = 0;
    let settled = false;
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({status, signal, out: `${stdout}\n${stderr}`});
    };
    const pump = () => {
      while (scriptIndex < script.length && script[scriptIndex].match.test(stdout)) {
        const {answer} = script[scriptIndex];
        scriptIndex += 1;
        try { child.stdin.write(`${answer}\n`); } catch { /* stdin already closed */ }
      }
      if (stopAt.test(stdout)) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
    };
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); pump(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", () => settle(null, null));
    const watchdog = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
    }, timeoutMs);
    child.on("close", (code, signal) => settle(code, signal));
  });
}

const model = "opencode/deepseek-v4.1-flash-free";
const role = {model, reasoning: "high", variant: ""};

try {
  const one = writeFakeOpenCode("1");
  const two = writeFakeOpenCode("2");

  // ── 1. Generation detection from the real captured help text ──
  assert.equal(generationFromHelp(fs.readFileSync(path.join(fixtures, "opencode-1x-run-help.txt"), "utf8")), "1");
  assert.equal(generationFromHelp(fs.readFileSync(path.join(fixtures, "opencode-2x-run-help.txt"), "utf8")), "2");

  const caps2 = await discoverCapabilities({...agents.opencode, binary: two.binary});
  assert.equal(caps2.opencode_generation, "2");
  assert.equal(caps2.model, true);
  assert.equal(caps2.effort, true, "2.x effort is the model suffix");
  assert.equal(caps2.effort_flag, null, "2.x has no --variant flag");
  assert.equal(caps2.effort_mode, "model_suffix");
  assert.equal(caps2.standalone, true);
  assert.equal(caps2.variant, false);
  console.log("PASS: 2.x capabilities detect model-suffix effort and --standalone");

  const caps1 = await discoverCapabilities({...agents.opencode, binary: one.binary});
  assert.equal(caps1.opencode_generation, "1");
  assert.equal(caps1.effort, true);
  assert.equal(caps1.effort_flag, "--variant");
  assert.equal(caps1.variant, false);
  assert.notEqual(caps1.standalone, true);
  console.log("PASS: 1.x capabilities keep --variant unchanged");

  // ── 1b. Capability discovery warms the per-binary generation cache ──
  // The driver and verifier receive only `{binary}`, while discovery gets the
  // full manifest (with help_args). One probe must serve all of them, and no
  // launch-time caller may spawn the CLI again.
  const counted = writeCountingFakeOpenCode("2");
  const countedCaps = await discoverCapabilities({...agents.opencode, binary: counted.binary});
  assert.equal(countedCaps.opencode_generation, "2");
  const spawnCount = () => {
    try { return fs.readFileSync(counted.counter, "utf8").split("\n").filter(Boolean).length; }
    catch { return 0; }
  };
  const probesAfterDiscovery = spawnCount();
  assert.ok(probesAfterDiscovery >= 1, "capability discovery must have probed the fake");
  const countedWrite = driver.buildInvocation({binary: counted.binary, mode: "write", model, reasoning: "high"});
  assert.ok(countedWrite.args.includes("--standalone"), countedWrite.args.join(" "));
  assert.deepEqual(verifyAgentInvocation(countedWrite.args, role, {...agents.opencode, binary: counted.binary}), {ok: true, errors: []});
  assert.equal(spawnCount(), probesAfterDiscovery, "buildInvocation and verifyAgentInvocation must not re-probe after capability discovery");
  console.log("PASS: capability discovery warms the generation cache; launch-time callers spawn no probe");

  // ── 2. 2.x driver invocation: --standalone + model#level, no --variant ──
  const write2 = driver.buildInvocation({binary: two.binary, mode: "write", model, reasoning: "high"});
  assert.ok(write2.args.includes("--standalone"), write2.args.join(" "));
  assert.ok(!write2.args.includes("--variant"), write2.args.join(" "));
  assert.equal(write2.args[write2.args.indexOf("--model") + 1], `${model}#high`);
  assert.deepEqual(driver.appliedSelections(write2), {model, reasoning: "high"});
  assert.deepEqual(verifyAgentInvocation(write2.args, role, {...agents.opencode, binary: two.binary}), {ok: true, errors: []});

  const read2 = driver.buildInvocation({binary: two.binary, mode: "read", model, reasoning: "high"});
  assert.ok(read2.args.includes("--standalone"), read2.args.join(" "));
  assert.ok(read2.args.includes("--agent") && read2.args.includes("autopilot_readonly"), read2.args.join(" "));
  assert.ok(!read2.args.includes("--variant"), read2.args.join(" "));
  assert.equal(read2.args[read2.args.indexOf("--model") + 1], `${model}#high`);
  assert.deepEqual(driver.appliedSelections(read2), {model, reasoning: "high"});
  assert.deepEqual(verifyAgentInvocation(read2.args, role, {...agents.opencode, binary: two.binary}), {ok: true, errors: []});
  console.log("PASS: 2.x write/read_only invocations carry --standalone and model#level, no --variant");

  // ── 3. The relay selection path (buildRelayArgs uses applyAgentSelections) ──
  const relay2 = applyAgentSelections([...agents.opencode.write], role, {...agents.opencode, binary: two.binary});
  assert.ok(relay2.includes("--standalone"), relay2.join(" "));
  assert.ok(!relay2.includes("--variant"), relay2.join(" "));
  assert.equal(relay2[relay2.indexOf("--model") + 1], `${model}#high`);
  assert.deepEqual(verifyAgentInvocation(relay2, role, {...agents.opencode, binary: two.binary}), {ok: true, errors: []});

  const relayRead2 = applyAgentSelections([...agents.opencode.read_only], role, {...agents.opencode, binary: two.binary});
  assert.ok(relayRead2.includes("--standalone"), relayRead2.join(" "));
  assert.ok(relayRead2.includes("autopilot_readonly"), relayRead2.join(" "));
  assert.equal(relayRead2[relayRead2.indexOf("--model") + 1], `${model}#high`);
  assert.deepEqual(verifyAgentInvocation(relayRead2, role, {...agents.opencode, binary: two.binary}), {ok: true, errors: []});
  console.log("PASS: 2.x relay selections use the model suffix and add --standalone");

  // ── 4. 1.x invocation is byte-for-byte unchanged ──
  assert.deepEqual(
    driver.buildInvocation({binary: one.binary, mode: "write", model, reasoning: "high"}).args,
    ["run", "--print-logs", "--format", "json", "--auto", "--model", model, "--variant", "high"]
  );
  assert.deepEqual(
    driver.buildInvocation({binary: one.binary, mode: "read"}).args,
    ["run", "--print-logs", "--format", "json", "--agent", "autopilot_readonly"]
  );
  assert.deepEqual(
    applyAgentSelections([...agents.opencode.write], role, {...agents.opencode, binary: one.binary}),
    ["run", "--print-logs", "--format", "json", "--auto", "--model", model, "--variant", "high"]
  );
  const write1 = driver.buildInvocation({binary: one.binary, mode: "write", model, reasoning: "high"});
  assert.deepEqual(driver.appliedSelections(write1), {model, reasoning: "high"});
  assert.deepEqual(verifyAgentInvocation(write1.args, role, {...agents.opencode, binary: one.binary}), {ok: true, errors: []});
  console.log("PASS: 1.x invocation remains unchanged (--variant, no --standalone)");

  // ── 5. 2.x discovery parses the real /api/model sample ──
  const catalog2 = await discoverModelCatalog({...agents.opencode, binary: two.binary});
  assert.equal(catalog2.status, "reported");
  assert.equal(catalog2.length, 9);
  const deepseek = catalog2.find(item => item.id === model);
  assert.ok(deepseek, "deepseek model must be discovered");
  assert.deepEqual(deepseek.reasoning, ["low", "high", "max"]);
  assert.deepEqual(deepseek.variants, ["low", "high", "max"]);
  const noVariants = catalog2.find(item => item.id === "opencode/big-pickle");
  assert.deepEqual(noVariants.reasoning, [], "a model with no variants exposes no levels");
  console.log("PASS: 2.x discovery parses provider/id and variants from /api/model");

  const catalog1 = await discoverModelCatalog({...agents.opencode, binary: one.binary});
  assert.equal(catalog1.status, "reported");
  assert.equal(catalog1[0].id, "opencode/fake-model");
  assert.deepEqual(catalog1[0].variants, ["low", "medium", "high"]);
  console.log("PASS: 1.x discovery still uses models --verbose");

  // ── 5b. A 1.x-saved reasoning value validates on 2.x (no migration) ──
  const saved = await validateRoleSelection({
    roleName: "implementer",
    role: {adapter: "opencode", model, reasoning: "high", variant: "", resume: false},
    adapter: {...agents.opencode, binary: two.binary},
    agents: {opencode: {...agents.opencode, binary: two.binary}}
  });
  assert.equal(saved.valid, true, `1.x-saved reasoning must validate on 2.x: ${JSON.stringify(saved.errors)}`);
  assert.ok(!saved.errors.some(error => /does not advertise effort|does not support reasoning/.test(error)), JSON.stringify(saved.errors));
  console.log("PASS: a 1.x-saved reasoning value validates on 2.x without migration");

  // ── 6. Setup and ap config show the same numbered level list on 2.x ──
  const wizardRepo = fs.mkdtempSync(path.join(scratch, "repo-wizard-"));
  const wizard = await runSetupInteractively({
    binDir: two.dir,
    repo: wizardRepo,
    args: ["--wizard"],
    script: [
      {match: /Press Enter to continue/, answer: ""},
      {match: /\nPlanner CLI\n/, answer: "1"},
      {match: /Planner model \(live discovery from opencode\)/, answer: "3"}
    ],
    stopAt: /4\) max/
  });
  assert.match(wizard.out, /Planner reasoning\/effort \(for selected model\)/, wizard.out.slice(-3000));
  assert.match(wizard.out, /1\) Use CLI default\s*\n2\) low\s*\n3\) high\s*\n4\) max/, wizard.out.slice(-3000));
  console.log("PASS: setup wizard renders the 2.x model's numbered level list");

  const noLevelsRepo = fs.mkdtempSync(path.join(scratch, "repo-no-levels-"));
  const noLevels = await runSetupInteractively({
    binDir: two.dir,
    repo: noLevelsRepo,
    args: ["--wizard"],
    script: [
      {match: /Press Enter to continue/, answer: ""},
      {match: /\nPlanner CLI\n/, answer: "1"},
      {match: /Planner model \(live discovery from opencode\)/, answer: "2"}
    ],
    stopAt: /has no selectable reasoning levels — the CLI decides\./
  });
  assert.match(noLevels.out, /Planner: opencode\/big-pickle has no selectable reasoning levels — the CLI decides\./, noLevels.out.slice(-3000));
  assert.doesNotMatch(noLevels.out, /Planner reasoning\/effort/, "a model with no variants must not be asked");
  console.log("PASS: a 2.x model with no variants is not asked for reasoning");

  // A completed wizard run gives `ap config --edit` an existing config.
  const editRepo = fs.mkdtempSync(path.join(scratch, "repo-edit-"));
  const prepared = runSetupSync({binDir: two.dir, repo: editRepo, args: ["--wizard"]});
  assert.equal(prepared.error, undefined, `preparation setup failed to spawn: ${prepared.error?.message}`);
  assert.equal(prepared.status, 0, `preparation setup exited ${prepared.status}\n${prepared.out.slice(-2000)}`);
  assert.ok(fs.existsSync(path.join(editRepo, ".autopilot", "config.json")), "setup must write a config for the edit run");

  const edit = await runSetupInteractively({
    binDir: two.dir,
    repo: editRepo,
    args: ["--edit"],
    script: [
      {match: /Configuration scope:/, answer: "1"},
      {match: /\nPlanner CLI\n/, answer: "1"},
      {match: /Planner model \(live discovery from opencode\)/, answer: "3"}
    ],
    stopAt: /4\) max/
  });
  assert.match(edit.out, /Planner reasoning\/effort \(for selected model\)/, edit.out.slice(-3000));
  assert.match(edit.out, /1\) Use CLI default\s*\n2\) low\s*\n3\) high\s*\n4\) max/, edit.out.slice(-3000));
  console.log("PASS: ap config --edit renders the same 2.x level list");

  console.log("OpenCode 2.x support tests passed");
} finally {
  if (previousPath == null) delete process.env.PATH; else process.env.PATH = previousPath;
  fs.rmSync(scratch, {recursive: true, force: true});
}
