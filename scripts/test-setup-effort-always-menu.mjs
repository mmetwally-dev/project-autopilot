#!/usr/bin/env node
// The reasoning/effort question is always a numbered menu, never free text:
// a CLI-default model with a documented list (claude) gets that list, and a
// model with no known levels gets a one-line notice instead of a prompt.
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

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-effort-menu-"));
const binDir = path.join(temporary, "bin");
fs.mkdirSync(binDir);
const helpHook = path.join(temporary, "fake-claude-help.cjs");
fs.writeFileSync(helpHook, [
  'if (process.argv.length === 1) {',
  '  process.stdout.write("Usage: claude\\n  --model <name>\\n  --effort <level>\\n");',
  '  process.exit(0);',
  '}'
].join("\n"));
const claudeBin = path.join(binDir, "claude");
fs.symlinkSync(process.execPath, claudeBin);

function runSetup(modelAnswer, stopAt) {
  const repo = fs.mkdtempSync(path.join(temporary, "repo-"));
  return new Promise(resolve => {
    const env = {
      ...process.env,
      PATH: [binDir, "/usr/bin", "/bin"].join(":"),
      NODE_OPTIONS: `--require ${helpHook}`
    };
    const child = spawn(process.execPath, [path.join(here, "setup.mjs"), "--wizard", "--repo", repo],
      {cwd: root, env, stdio: ["pipe", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    let scriptIndex = 0;
    let settled = false;
    const script = [
      {match: /Press Enter to continue/, answer: ""},
      {match: /\nPlanner CLI\n/, answer: "1"},
      {match: /Planner model \(documented options for claude\)/, answer: modelAnswer}
    ];
    const settle = status => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fs.rmSync(repo, {recursive: true, force: true});
      resolve({status, out: `${stdout}\n${stderr}`});
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
    child.on("error", () => settle(null));
    const watchdog = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
    }, 30000);
    child.on("close", status => settle(status));
  });
}

try {
  const cliDefault = await runSetup("1", /Planner reasoning\/effort[\s\S]*: $/);
  check("claude CLI default shows the documented source line",
    cliDefault.out.includes("Planner: documented reasoning/effort levels (not live-verified for the CLI default model)"),
    cliDefault.out);
  check("claude CLI default shows a numbered menu with xhigh and max",
    /1\) Use CLI default\s*\n2\) low\s*\n3\) medium\s*\n4\) high\s*\n5\) xhigh\s*\n6\) max/.test(cliDefault.out),
    cliDefault.out);

  const noLevels = await runSetup("7", /has no selectable reasoning levels — the CLI decides\./);
  check("haiku prints the no-selectable-levels line",
    noLevels.out.includes("Planner: haiku has no selectable reasoning levels — the CLI decides."),
    noLevels.out);
  check("haiku is not asked a reasoning/effort question",
    !/Planner reasoning\/effort/.test(noLevels.out),
    noLevels.out);

  check("neither run contains a bare reasoning/effort free-text prompt",
    !/reasoning\/effort:/.test(`${cliDefault.out}\n${noLevels.out}`),
    `${cliDefault.out}\n${noLevels.out}`);
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
if (failures) { console.error(`${failures} setup-effort-always-menu check(s) failed.`); process.exit(1); }
console.log("setup effort always-menu tests passed");
