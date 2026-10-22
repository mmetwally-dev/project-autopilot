#!/usr/bin/env node
// Mission 090 task 2.3: setup end-of-wizard refresh assertions.
// Covers: a fresh `setup --wizard` run and a re-run (`setup --edit`) both
// leave current command files for PATH-detected agents only; a deleted file
// is restored and stale content is refreshed, with no duplicates.
// Run: node scripts/test-090-commands-setup-refresh.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderAgentCommands } from "./agent-command-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const setupScript = path.join(here, "setup.mjs");

const tmpBase = process.env.TMPDIR || os.tmpdir();
const delimiter = process.platform === "win32" ? ";" : ":";
const systemDirs = process.platform === "win32"
  ? [`${process.env.SystemRoot || "C:\\Windows"}\\System32`]
  : ["/usr/bin", "/bin"];

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function makeFakeCliDir() {
  const binDir = fs.mkdtempSync(path.join(tmpBase, "ap-090-setup-refresh-bin-"));
  const fakeClaude = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    fs.writeFileSync(fakeClaude, "@echo off\nexit /b 0\n");
  } else {
    const realTrue = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
    fs.copyFileSync(realTrue, fakeClaude);
    fs.chmodSync(fakeClaude, 0o755);
  }
  return binDir;
}

function hermeticEnv(binDir, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: [binDir, ...systemDirs].join(delimiter),
  };
}

function listApFiles(repo) {
  const dir = path.join(repo, ".claude", "commands");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^ap\..*\.md$/.test(f)).sort();
}

function expectedContents() {
  return Object.fromEntries(
    renderAgentCommands("claude").map((r) => [r.relPath, r.content]),
  );
}

function checkCurrentFiles(repo, label) {
  const files = listApFiles(repo);
  // Backlog open #7: claude renders the mission-control pair too (10 files).
  check(`${label}: exactly the ten claude command files`,
    JSON.stringify(files) === JSON.stringify(Object.keys(expectedContents()).map((r) => r.replace(".claude/commands/", "")).sort()),
    JSON.stringify(files));
  const expected = expectedContents();
  let contentsOk = files.length === Object.keys(expected).length;
  for (const [rel, content] of Object.entries(expected)) {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== content) {
      contentsOk = false;
    }
  }
  check(`${label}: contents match the shared render`, contentsOk, "");
}

// Fresh-setup driver: the interactive pump from test-setup-first-run-e2e.mjs.
// Answers are written only after observed stdout so stdin is never EOF-closed
// before readline exists (spawnSync({input}) would crash setup instead).
function runWizardFresh({ repo, binDir, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [setupScript, "--wizard", "--repo", repo],
      { cwd: root, env: hermeticEnv(binDir), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const answers = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? "" : "1"));
    let answerIndex = 0;
    let settled = false;
    let spawnError = null;
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (answerIndex < answers.length) {
        try { child.stdin.write(`${answers[answerIndex++]}\n`); } catch { /* exited */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { spawnError = error; });
    const watchdog = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { child.stdin.end(); } catch { /* already closed */ }
      resolve({ status, signal: timedOut ? (signal || "SIGKILL") : signal, error: spawnError, stdout, stderr, timedOut });
    });
  });
}

// Re-run driver: `setup --edit` on the narrowest scope that still saves
// (Framework / safety), with the scripted FORCE_INTERACTIVE answers from
// test-setup-gates-flow.mjs. Ends at the same end-of-wizard save block.
function runEditRerun({ repo, binDir, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [setupScript, "--edit", "--repo", repo],
      { cwd: root, env: hermeticEnv(binDir, { AUTOPILOT_SETUP_FORCE_INTERACTIVE: "1" }), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", (error) => { spawnError = error; });
    const watchdog = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ status, signal: timedOut ? (signal || "SIGKILL") : signal, error: spawnError, stdout, stderr, timedOut });
    });
    try {
      child.stdin.write("3\n1\n\n");
      child.stdin.end();
    } catch { /* child already gone */ }
  });
}

const binDir = makeFakeCliDir();
const repo = fs.mkdtempSync(path.join(tmpBase, "ap-090-setup-refresh-repo-"));
const started = Date.now();
try {
  // ── Fresh setup writes current files for detected agents only ──
  const fresh = await runWizardFresh({ repo, binDir });
  const freshCombined = `${fresh.stdout}\n${fresh.stderr}`;
  check("fresh setup completes cleanly",
    fresh.status === 0 && !fresh.timedOut && !fresh.error,
    `status=${fresh.status} timedOut=${fresh.timedOut} signal=${fresh.signal} error=${fresh.error}\n${freshCombined.slice(-1500)}`);
  check("fresh setup writes .autopilot/config.json",
    fs.existsSync(path.join(repo, ".autopilot", "config.json")), "");
  checkCurrentFiles(repo, "fresh setup");

  // ── Re-run refreshes: deleted file restored, stale content refreshed ──
  const victim = path.join(repo, ".claude", "commands", "ap.plan.md");
  const staleFile = path.join(repo, ".claude", "commands", "ap.run.md");
  let preconditionOk = fs.existsSync(victim) && fs.existsSync(staleFile);
  if (preconditionOk) {
    fs.unlinkSync(victim);
    fs.writeFileSync(staleFile, "stale content\n");
    preconditionOk = !fs.existsSync(victim) && fs.readFileSync(staleFile, "utf8") === "stale content\n";
  }
  check("refresh precondition: one file deleted, one gone stale", preconditionOk, "");
  const rerun = await runEditRerun({ repo, binDir });
  const rerunCombined = `${rerun.stdout}\n${rerun.stderr}`;
  check("re-run completes cleanly",
    rerun.status === 0 && !rerun.timedOut && !rerun.error,
    `status=${rerun.status} timedOut=${rerun.timedOut} signal=${rerun.signal} error=${rerun.error}\n${rerunCombined.slice(-1500)}`);
  checkCurrentFiles(repo, "re-run");
} catch (error) {
  failed++;
  console.log(`FAIL setup-refresh harness threw :: ${error?.stack || error}`);
} finally {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(binDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const elapsed = Date.now() - started;
check(`whole file under 100s`, elapsed < 100000, `${elapsed} ms`);
console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
