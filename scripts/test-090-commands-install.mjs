#!/usr/bin/env node
// Mission 090 task 2.2: install-helper assertions.
// Covers: helper writes files only for PATH-detected agents, re-run
// refreshes without duplicates, the registry CLI honours --repo, and
// `ap commands` reinstalls on demand.
// Run: node scripts/test-090-commands-install.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  COMMAND_FILES,
  detectedAgents,
  installAgentCommands,
  isAgentDetected,
  renderAgentCommands,
} from "./agent-command-registry.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const savedPath = process.env.PATH ?? "";
const tmpBase = process.env.TMPDIR || os.tmpdir();

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(tmpBase, `ap-090-install-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function makeBinDir(prefix, names) {
  const dir = fs.mkdtempSync(path.join(tmpBase, `ap-090-install-bin-${prefix}-`));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\nexit 0\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function listApFiles(repo) {
  const dir = path.join(repo, ".claude", "commands");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^ap\..*\.md$/.test(f)).sort();
}

// Backlog open #7: claude/opencode render stop+cancel (10 files) while
// antigravity excludes them (8 skill files) — computed from the registry.
const claudeOcFiles = renderAgentCommands("claude").map((r) => r.file).sort();
const expectedWrittenCount =
  renderAgentCommands("claude").length
  + renderAgentCommands("opencode").length
  + renderAgentCommands("antigravity").length;

function withPathEnv(value, fn) {
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
  }
}

// ── Detection: manifest binary on PATH ──
{
  const bin = makeBinDir("detect", ["claude"]);
  withPathEnv(bin, () => {
    check("[detect] claude detected with fixture binary on PATH",
      isAgentDetected("claude") === true, "");
  });
  const empty = makeBinDir("empty", []);
  withPathEnv(empty, () => {
    check("[detect] claude not detected with empty PATH",
      isAgentDetected("claude") === false, "");
    check("[detect] no agents detected with empty PATH",
      JSON.stringify(detectedAgents()) === JSON.stringify([]),
      JSON.stringify(detectedAgents()));
  });
}

// ── Helper writes only detected agents' files ──
{
  const bin = makeBinDir("write", ["claude", "codex", "opencode", "cursor-agent", "agy"]);
  const repo = makeRepo("write");
  const result = withPathEnv(bin, () => installAgentCommands(repo));
  check("[install] detected list is claude+opencode+antigravity even with every binary present",
    JSON.stringify(result.detected) === JSON.stringify(["claude", "opencode", "antigravity"]),
    JSON.stringify(result.detected));
  check("[install] writes exactly the ten claude command files",
    JSON.stringify(listApFiles(repo)) === JSON.stringify(claudeOcFiles),
    JSON.stringify(listApFiles(repo)));
  const ocDir = path.join(repo, ".opencode", "command");
  check("[install] writes exactly the ten opencode ap.*.md files",
    JSON.stringify(fs.readdirSync(ocDir).sort())
    === JSON.stringify(claudeOcFiles),
    JSON.stringify(fs.readdirSync(ocDir)));
  check("[install] codex/cursor write nothing",
    !fs.existsSync(path.join(repo, ".cursor")) && !fs.existsSync(path.join(repo, ".codex")), "");
  const expected = Object.fromEntries(
    [...renderAgentCommands("claude"), ...renderAgentCommands("opencode"), ...renderAgentCommands("antigravity")].map((r) => [r.relPath, r.content]),
  );
  let contentsOk = result.written.length === expectedWrittenCount;
  for (const [rel, content] of Object.entries(expected)) {
    const actual = fs.existsSync(path.join(repo, rel))
      ? fs.readFileSync(path.join(repo, rel), "utf8")
      : null;
    if (actual !== content) contentsOk = false;
  }
  check("[install] written contents match the shared render", contentsOk, "");
}

// ── Helper writes nothing when no agent is detected ──
{
  const empty = makeBinDir("none", []);
  const repo = makeRepo("none");
  const result = withPathEnv(empty, () => installAgentCommands(repo));
  check("[install] nothing detected on empty PATH",
    result.detected.length === 0 && result.written.length === 0,
    JSON.stringify(result));
  check("[install] no command directory created when nothing detected",
    !fs.existsSync(path.join(repo, ".claude")), "");
}

// ── Refresh is idempotent ──
{
  const bin = makeBinDir("idempotent", ["claude"]);
  const repo = makeRepo("idempotent");
  withPathEnv(bin, () => {
    installAgentCommands(repo);
    const first = listApFiles(repo).map((f) =>
      fs.readFileSync(path.join(repo, ".claude", "commands", f), "utf8"));
    installAgentCommands(repo);
    const second = listApFiles(repo).map((f) =>
      fs.readFileSync(path.join(repo, ".claude", "commands", f), "utf8"));
    check("[refresh] re-run leaves exactly the rendered file set",
      JSON.stringify(listApFiles(repo)) === JSON.stringify(claudeOcFiles),
      JSON.stringify(listApFiles(repo)));
    check("[refresh] re-run refreshes without duplicates or drift",
      JSON.stringify(first) === JSON.stringify(second), "");
  });
}

// ── Registry CLI honours --repo ──
{
  const bin = makeBinDir("cli", ["claude"]);
  const repo = makeRepo("cli");
  const elsewhere = makeBinDir("cwd", []);
  const result = spawnSync(
    process.execPath,
    [path.join(skillRoot, "scripts", "agent-command-registry.mjs"), "install", "--repo", repo],
    { cwd: elsewhere, env: { ...process.env, PATH: bin }, encoding: "utf8" },
  );
  check("[cli] install --repo exits 0",
    result.status === 0, `status=${result.status} stderr=${result.stderr}`);
  check("[cli] install --repo writes into the repo, not the cwd",
    JSON.stringify(listApFiles(repo)) === JSON.stringify(claudeOcFiles)
    && !fs.existsSync(path.join(elsewhere, ".claude")),
    JSON.stringify(listApFiles(repo)));
}

// ── `ap commands` reinstalls on demand ──
{
  const bin = makeBinDir("apcmd", ["claude"]);
  const repo = makeRepo("apcmd");
  withPathEnv(bin, () => installAgentCommands(repo));
  const victim = path.join(repo, ".claude", "commands", "ap.plan.md");
  fs.unlinkSync(victim);
  check("[ap commands] precondition: one file deleted", !fs.existsSync(victim), "");
  const result = spawnSync(
    process.execPath,
    [path.join(skillRoot, "bin", "ap.cjs"), "commands", "--repo", repo],
    { env: { ...process.env, PATH: bin }, encoding: "utf8" },
  );
  check("[ap commands] exits 0", result.status === 0,
    `status=${result.status} stderr=${result.stderr}`);
  const expected = renderAgentCommands("claude").find((r) => r.file === "ap.plan.md").content;
  check("[ap commands] deleted file is reinstalled with rendered content",
    fs.existsSync(victim) && fs.readFileSync(victim, "utf8") === expected, "");
}

// ── `ap help` documents the route ──
{
  const result = spawnSync(
    process.execPath,
    [path.join(skillRoot, "bin", "ap.cjs"), "help"],
    { encoding: "utf8" },
  );
  check("[usage] ap help names ap commands",
    result.status === 0 && String(result.stdout || "").includes("ap commands"),
    `status=${result.status}`);
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
