#!/usr/bin/env node
// Task 042-1.5: no new role run may launch after SIGTERM/SIGINT.
// Static: shuttingDown flag declared, set-first in the interrupt flush,
// checked at runRelay() entry before any runDirFor/mkdir artifact.
// Runtime: real `ap run` (standalone) with a blocking fake adapter that
// dies on SIGTERM (default disposition); SIGTERM the orchestrator, wait
// for exit, then assert no run dir was created after the signal and the
// interrupted run is marked `interrupted` in its status.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name, condition, extra = "") => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const autoSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// ---- Static checks ----
check("shuttingDown flag declared", /let\s+shuttingDown\s*=\s*false/.test(autoSrc));
check("flush sets shuttingDown before kill/flush",
  autoSrc.indexOf("shuttingDown=true") !== -1 &&
  autoSrc.indexOf("shuttingDown=true") < autoSrc.indexOf("killActiveProcessGroupSync(activeChildPid)") &&
  autoSrc.indexOf("shuttingDown=true") < autoSrc.indexOf("markInterrupted(activeRunDir"));
check("runRelay refuses new runs while shutting down",
  /if\s*\(\s*shuttingDown\s*\)/.test(autoSrc) &&
  /refusing to start/.test(autoSrc));
check("runRelay guard sits before runDirFor/mkdir",
  autoSrc.indexOf("if(shuttingDown)") !== -1 &&
  autoSrc.indexOf("if(shuttingDown)") < autoSrc.indexOf("{dir,mission}=runDirFor(s,id,roleName)"));

if (process.platform === "win32") {
  console.log("SKIP runtime no-new-run test on Windows");
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log("no-new-run-after-signal tests passed");
  process.exit(0);
}

// ---- Runtime: fixture repo with a blocking cursor adapter ----
const { makeFixtureRepo, writeConfig, withoutOuterGitGuard } =
  await import("./test-fixtures/workflow-order-harness.mjs");

const repo = makeFixtureRepo("no-new-run");
let binDir = null;
let orch = null;
try {
  writeConfig(repo, { planningFramework: "standalone" });
  // Commit a scenario file for harness parity (blocking adapter ignores it).
  {
    const { execFileSync } = await import("node:child_process");
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-scenario"), "success");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    try { execFileSync("git", ["add", "-f", ".autopilot/.autopilot-test-scenario"], { cwd: repo }); } catch {}
    execFileSync("git", ["commit", "-q", "-m", "test scenario: success"], { cwd: repo });
  }
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-no-new-run-bin-"));
  // Fake adapter: fast --version probe, otherwise block (default SIGTERM
  // disposition => exits immediately on SIGTERM, per the task contract).
  fs.writeFileSync(path.join(binDir, "cursor-agent"),
    '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo "fake-cursor-agent 1.0.0"; exit 0; fi\nexec sleep 60\n');
  fs.chmodSync(path.join(binDir, "cursor-agent"), 0o755);

  const base = withoutOuterGitGuard(process.env);
  const env = { ...base, PATH: `${binDir}:${base.PATH || ""}` };
  orch = spawn(process.execPath, [path.join(here, "autopilot.mjs"), "run", "fixture request", "--repo", repo],
    { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let orchOut = "";
  orch.stdout?.on("data", (d) => { orchOut += d; });
  orch.stderr?.on("data", (d) => { orchOut += d; });
  const orchExited = new Promise((res) => orch.on("exit", (code, signal) => res({ code, signal })));

  const findRunDirs = () => {
    const out = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (fs.existsSync(path.join(full, "status.json"))) out.push(full);
          walk(full);
        }
      }
    })(path.join(repo, ".autopilot"));
    return out;
  };

  // Wait for the first (planner) run dir = live adapter relay in flight.
  const deadline = Date.now() + 60000;
  let runs = [];
  while (Date.now() < deadline) {
    runs = findRunDirs();
    if (runs.length > 0) break;
    if (orch.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("planner run dir appeared before signal", runs.length > 0);
  if (runs.length === 0) {
    try { orch.kill("SIGKILL"); } catch {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
    console.error(`${failures} check(s) failed.\n${orchOut.slice(-2000)}`);
    process.exit(1);
  }
  // Settle: ensure the adapter child has spawned and the flush is armed.
  await new Promise((r) => setTimeout(r, 1000));
  const beforeCount = findRunDirs().length;
  const signalTime = Date.now();
  try { process.kill(orch.pid, "SIGTERM"); } catch {}

  const exit = await Promise.race([
    orchExited,
    new Promise((res) => setTimeout(() => res(null), 20000)),
  ]);
  check("orchestrator exited after SIGTERM", exit !== null);
  // Grace: let the tree fully reap before asserting on disk state.
  await new Promise((r) => setTimeout(r, 2000));

  const after = findRunDirs();
  const newDirs = after.filter((d) => {
    try { return fs.statSync(d).mtimeMs > signalTime; } catch { return false; }
  });
  // Re-list defensively: a run dir created after the signal with a clamped
  // mtime would still be a NEW path; count growth alone is a failure.
  check("no new run dir created after signal",
    newDirs.length === 0 && after.length <= beforeCount,
    `before=${beforeCount} after=${after.length} newMtime=${newDirs.join(",")}`);

  let interrupted = 0;
  for (const d of after) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(d, "status.json"), "utf8"));
      if (st.status === "interrupted") interrupted += 1;
    } catch {}
  }
  check("interrupted run marked interrupted in status.json", interrupted >= 1, `dirs=${after.length}`);
} finally {
  try { if (orch && orch.exitCode === null) orch.kill("SIGKILL"); } catch {}
  try { if (binDir) fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
}

if (failures) {
  console.error(`${failures} no-new-run-after-signal check(s) failed.`);
  process.exit(1);
}
console.log("no-new-run-after-signal tests passed");
