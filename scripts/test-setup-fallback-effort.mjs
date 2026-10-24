#!/usr/bin/env node
// Wizard fallback add asks for reasoning/effort the same way the main role
// does (backlog #84 follow-up): an effort-capable fallback adapter gets the
// effort menu and the chosen level is saved on the fallback entry; an
// adapter without an effort flag is not asked and saves "".
// Hermetic: fake `codex` (model/list responder, documented effort levels)
// and fake `claude` (ELF copy of `true`: no effort capability) on PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail === undefined ? "" : ` -- ${String(detail).slice(-1500)}`}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-fb-effort-"));
const binDir = path.join(temporary, "bin");
fs.mkdirSync(binDir);
const server = path.join(temporary, "fake-codex.mjs");
fs.writeFileSync(server, [
  'const args = process.argv.slice(2);',
  'if (args[0] === "--version") { process.stdout.write("codex-test 1.0.0\\n"); process.exit(0); }',
  'if (args[0] === "--help") { process.stdout.write("Usage: codex\\n  --model <name>\\n  --config <key=value>\\n"); process.exit(0); }',
  'if (args[0] === "app-server") {',
  '  process.stdin.setEncoding("utf8");',
  '  let buffer = "";',
  '  process.stdin.on("data", chunk => {',
  '    buffer += chunk;',
  '    if (buffer.includes(\'"method":"model/list"\')) {',
  '      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{data:[{slug:"fake-model",displayName:"Fake Model"}]}}) + "\\n");',
  '    }',
  '  });',
  '} else { process.exit(0); }'
].join("\n"));
const codexBin = path.join(binDir, "codex");
fs.writeFileSync(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
fs.chmodSync(codexBin, 0o755);
const claudeBin = path.join(binDir, "claude");
fs.copyFileSync(fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true", claudeBin);
fs.chmodSync(claudeBin, 0o755);

// FORCE_INTERACTIVE makes setup read the whole positional answer block from
// stdin up front. Only the Planner role adds a fallback; the other four
// roles pick claude and answer No.
function run(plannerAnswers) {
  const repo = fs.mkdtempSync(path.join(temporary, "repo-"));
  const answers = ["", ...plannerAnswers, "1", "1", "1", "1", "1", "1", "1", "1", "1", "", "y"];
  return new Promise(resolve => {
    const env = {...process.env, PATH: [binDir, "/usr/bin", "/bin"].join(":"), AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1"};
    const child = spawn(process.execPath, [path.join(here, "setup.mjs"), "--wizard", "--repo", repo],
      {cwd: root, env, stdio: ["pipe", "pipe", "pipe"]});
    let out = "";
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", c => { out += c.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.stdin.end(answers.map(a => `${a}\n`).join(""));
    child.on("close", status => {
      clearTimeout(watchdog);
      let config = null;
      try { config = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8")); } catch {}
      resolve({status, out, config});
    });
  });
}


try {
  // Planner primary = claude (option picked by label lookup is positional:
  // the default 1 is used), then add a codex fallback and choose effort.
  const withEffort = await run(["1", "2", "2", "2", "4", "1"]);
  check("effort case: fallback asks reasoning/effort", /Planner fallback reasoning\/effort \(for selected model\)/.test(withEffort.out), withEffort.out);
  const fb = withEffort.config?.roles?.planner?.fallbacks?.[0];
  check("effort case: fallback adapter is codex", fb?.cli === "codex", JSON.stringify(withEffort.config?.roles?.planner));
  check("effort case: chosen level saved", fb?.reasoning === "high", JSON.stringify(fb));
  check("effort case: variant empty", !fb?.variant, JSON.stringify(fb));

  // Adapter without effort support: no question, "" saved.
  const noEffort = await run(["1", "2", "1", "1"]);
  const fb2 = noEffort.config?.roles?.planner?.fallbacks?.[0];
  check("no-effort case: fallback saved on claude", fb2?.cli === "claude", JSON.stringify(noEffort.config?.roles?.planner));
  check("no-effort case: no fallback effort prompt", !/Planner fallback reasoning\/effort/.test(noEffort.out), noEffort.out);
  check("no-effort case: reasoning and variant are empty", !fb2?.reasoning && !fb2?.variant, JSON.stringify(fb2));
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
if (failures) { console.error(`${failures} setup-fallback-effort check(s) failed.`); process.exit(1); }
console.log("setup fallback effort tests passed");
