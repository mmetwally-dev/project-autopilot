#!/usr/bin/env node
// Mission 090 task 1.4: stage-ordering guard wired into the run dispatch plus
// --stage help text. Subprocess cases on disposable fixtures (standalone
// framework): `ap run --stage review|verify` on a fresh fixture exits
// non-zero with the guard reason naming the missing prerequisite state; both
// help texts (autopilot.mjs `run --help`, `bin/ap.cjs`) document `--stage`.
// Run: node scripts/test-090-stage-guard-wire-help.mjs
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtureRepo, makeFixtureBin, writeConfig, withoutOuterGitGuard, cleanup, skillRoot } from "./test-fixtures/workflow-order-harness.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function runAutopilot(repo, binDir, args, { timeoutMs = 120000 } = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  delete base.AUTOPILOT_SPEC;
  const env = { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` };
  const result = spawnSync(process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), ...args, "--repo", repo],
    { cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false });
  return { status: result.status, timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"), stdout: result.stdout || "", stderr: result.stderr || "" };
}

// ── Guard wiring: --stage review on a fresh fixture names the missing state ──
{
  const repo = makeFixtureRepo("090-stage-guard-review");
  const binDir = makeFixtureBin("090-stage-guard-review");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const run = runAutopilot(repo, binDir, ["run", "--stage", "review", "fixture request"]);
    const combined = `${run.stdout}\n${run.stderr}`;
    check("[guard-wire] ap run --stage review on a fresh fixture exits non-zero",
      run.status !== 0 && !run.timedOut, `status=${run.status} timedOut=${run.timedOut}`);
    check("[guard-wire] --stage review refusal names the missing state (implementer)",
      /cannot run stage 'review'/i.test(combined) && /implementer/i.test(combined),
      `out=${JSON.stringify(combined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Guard wiring: --stage verify on a fresh fixture names the missing state ──
{
  const repo = makeFixtureRepo("090-stage-guard-verify");
  const binDir = makeFixtureBin("090-stage-guard-verify");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const run = runAutopilot(repo, binDir, ["run", "--stage", "verify", "fixture request"]);
    const combined = `${run.stdout}\n${run.stderr}`;
    check("[guard-wire] ap run --stage verify on a fresh fixture exits non-zero",
      run.status !== 0 && !run.timedOut, `status=${run.status} timedOut=${run.timedOut}`);
    check("[guard-wire] --stage verify refusal names the missing state (code_reviewer)",
      /cannot run stage 'verify'/i.test(combined) && /code_reviewer/i.test(combined),
      `out=${JSON.stringify(combined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Help texts document --stage ──
{
  const repo = makeFixtureRepo("090-stage-guard-help");
  const binDir = makeFixtureBin("090-stage-guard-help");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const help = runAutopilot(repo, binDir, ["run", "--help"], { timeoutMs: 30000 });
    const helpCombined = `${help.stdout}\n${help.stderr}`;
    check("[help] autopilot.mjs run --help documents --stage",
      help.status === 0 && helpCombined.includes("--stage"),
      `status=${help.status} out=${JSON.stringify(helpCombined.slice(-400))}`);
    const delimiter = process.platform === "win32" ? ";" : ":";
    const base = withoutOuterGitGuard(process.env);
    const apHelp = spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), "--help"],
      { cwd: repo, encoding: "utf8", env: { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` }, timeout: 30000, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const apCombined = `${apHelp.stdout || ""}\n${apHelp.stderr || ""}`;
    check("[help] bin/ap.cjs --help documents --stage",
      apHelp.status === 0 && apCombined.includes("--stage"),
      `status=${apHelp.status} out=${JSON.stringify(apCombined.slice(-400))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
