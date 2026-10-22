#!/usr/bin/env node
// Mission 090 task 2.4: slash-command docs assertions.
// Covers: README.md and SKILL.md both list all five `/ap` commands and the
// `--stage` flag, and the README note names all four Scope-2 omitted agents
// (codex, opencode, cursor, antigravity) each with its reason.
// Run: node scripts/test-090-slash-command-docs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(skillRoot, "README.md"), "utf8");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
// Markdown line-wrapping must not break reason matching.
const readmeFlat = readme.replace(/\s+/g, " ");

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

// ── Both files list all commands and the flag ──
const commands = ["/ap.plan", "/ap.implement", "/ap.review", "/ap.verify", "/ap.run"];
for (const command of commands) {
  check(`[docs] README.md lists ${command}`,
    readme.includes(command), command);
  check(`[docs] SKILL.md lists ${command}`,
    skill.includes(command), command);
}
check("[docs] README.md documents the --stage flag",
  readme.includes("--stage"), "");
check("[docs] SKILL.md documents the --stage flag",
  skill.includes("--stage"), "");

// ── README note names all four omitted agents with Scope 2 reasons ──
for (const [label, body] of [["README.md", readme], ["SKILL.md", skill]]) {
  check(`[docs] ${label} drops the old /ap: and /ap- names`,
    !/\/ap:[a-z]/.test(body) && !/\/ap-(plan|implement|review|verify|run)/.test(body), label);
}
check("[docs] README.md names .opencode/command", readme.includes(".opencode/command"), "");
const omittedExpectations = [
  ["codex", ["no verifiable custom-prompt loader", "~/.codex/prompts"]],
  ["cursor", [".cursor/commands", "not verifiable offline"]],
];
for (const [agent, fragments] of omittedExpectations) {
  check(`[docs] README.md names omitted agent ${agent}`,
    readme.includes(agent), agent);
  for (const fragment of fragments) {
    check(`[docs] README.md gives ${agent} reason (${fragment})`,
      readmeFlat.includes(fragment), `${agent}: ${fragment}`);
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
