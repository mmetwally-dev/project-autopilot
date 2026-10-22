#!/usr/bin/env node
// Mission 090 task 1.1: `--stage planning|implement|review|verify` arg parsing.
// Pure helper cases for parseRunArgs() plus fixture-subprocess cases for the
// dispatch refusal (implement/resume + bogus stage). Run: node scripts/test-090-stage-arg-parse.mjs
import { parseRunArgs } from "./mission-naming.mjs";
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

const VALID = ["planning", "implement", "review", "verify"];

// ── Pure helper cases ──────────────────────────────────────────────
const CASES = [
  { name: "absent stage is null", args: ["do", "the", "thing"], expect: { mission: "", request: "do the thing", stage: null, error: null } },
  { name: "empty args stage null", args: [], expect: { mission: "", request: "", stage: null, error: null } },
  { name: "plain request unaffected", args: ["x"], expect: { mission: "", request: "x", stage: null, error: null } },
  { name: "--stage prefix stripped", args: ["--stage", "planning", "do", "the", "thing"], expect: { request: "do the thing", stage: "planning", error: null } },
  { name: "--stage suffix stripped", args: ["do", "the", "thing", "--stage", "review"], expect: { request: "do the thing", stage: "review", error: null } },
  { name: "--stage mid-args stripped", args: ["do", "--stage", "verify", "the", "thing"], expect: { request: "do the thing", stage: "verify", error: null } },
  { name: "--stage implement parsed", args: ["--stage", "implement", "do", "thing"], expect: { request: "do thing", stage: "implement", error: null } },
  { name: "--stage alone leaves empty request", args: ["--stage", "planning"], expect: { request: "", stage: "planning", error: null } },
  { name: "--stage with --mission both parsed", args: ["--mission", "m", "--stage", "review", "do", "thing"], expect: { mission: "m", request: "do thing", stage: "review", error: null } },
  { name: "--stage with --repo both stripped", args: ["do", "thing", "--repo", "/tmp/x", "--stage", "verify"], expect: { request: "do thing", stage: "verify", error: null } },
  { name: "--stage bogus is a usage error", args: ["--stage", "bogus", "do", "thing"], expect: { error: "error" } },
  { name: "--stage missing value is a usage error", args: ["--stage"], expect: { error: "error" } },
  { name: "--stage trailing without value is a usage error", args: ["do", "thing", "--stage"], expect: { error: "error" } },
  { name: "--stage with flag-like value is a usage error", args: ["--stage", "--repo", "/tmp/x"], expect: { error: "error" } },
];

for (const c of CASES) {
  let got;
  try {
    got = parseRunArgs(c.args);
  } catch (e) {
    check(`[parse] ${c.name}`, false, `threw: ${e?.message || e}`);
    continue;
  }
  const shapeOk = got && typeof got === "object" && typeof got.mission === "string" && typeof got.request === "string"
    && (got.error === null || typeof got.error === "string") && ("stage" in got) && (got.stage === null || typeof got.stage === "string");
  if (!shapeOk) {
    check(`[parse] ${c.name}`, false, `bad shape: ${JSON.stringify(got)}`);
    continue;
  }
  const wantError = c.expect.error === "error";
  const errOk = wantError ? got.error !== null : got.error === null;
  const errNamesStages = wantError ? VALID.every((s) => String(got.error).includes(s)) : true;
  const missionOk = c.expect.mission === undefined || got.mission === c.expect.mission;
  const requestOk = c.expect.request === undefined || got.request === c.expect.request;
  const stageOk = c.expect.stage === undefined || got.stage === c.expect.stage;
  const noLeak = got.request.includes("--stage") === false;
  const ok = errOk && errNamesStages && missionOk && requestOk && stageOk && noLeak;
  check(`[parse] ${c.name}`, ok, ok ? "" : `args=${JSON.stringify(c.args)} got=${JSON.stringify(got)} want=${JSON.stringify(c.expect)}`);
}

// ── Subprocess cases (dispatch + wiring) ──────────────────────────
function runAutopilotCommand(repo, binDir, command, args, { timeoutMs = 60000 } = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  delete base.AUTOPILOT_SPEC;
  const env = { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` };
  const result = spawnSync(process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), command, ...args, "--repo", repo],
    { cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false });
  return { status: result.status, timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"), stdout: result.stdout || "", stderr: result.stderr || "" };
}

// `ap run --stage bogus` fails with usage naming valid stages.
{
  const repo = makeFixtureRepo("090-stage-bogus");
  const binDir = makeFixtureBin("090-stage-bogus");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const run = runAutopilotCommand(repo, binDir, "run", ["--stage", "bogus", "do", "thing"]);
    const combined = `${run.stdout}\n${run.stderr}`;
    const namesStages = VALID.every((s) => combined.includes(s));
    check("[subprocess] ap run --stage bogus fails with usage naming valid stages",
      run.status !== 0 && /usage error/i.test(combined) && namesStages,
      `status=${run.status} out=${JSON.stringify(combined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// `implement --stage implement` refused with usage pointing to ap run --stage.
{
  const repo = makeFixtureRepo("090-stage-implement-cmd");
  const binDir = makeFixtureBin("090-stage-implement-cmd");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const run = runAutopilotCommand(repo, binDir, "implement", ["--stage", "implement"]);
    const combined = `${run.stdout}\n${run.stderr}`;
    check("[subprocess] implement --stage implement refused with usage pointing to ap run --stage",
      run.status !== 0 && /usage error/i.test(combined) && combined.includes("ap run --stage"),
      `status=${run.status} out=${JSON.stringify(combined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

// `resume --stage review` refused with usage pointing to ap run --stage.
{
  const repo = makeFixtureRepo("090-stage-resume-cmd");
  const binDir = makeFixtureBin("090-stage-resume-cmd");
  try {
    writeConfig(repo, { planningFramework: "standalone" });
    const run = runAutopilotCommand(repo, binDir, "resume", ["--stage", "review"]);
    const combined = `${run.stdout}\n${run.stderr}`;
    check("[subprocess] resume --stage review refused with usage pointing to ap run --stage",
      run.status !== 0 && /usage error/i.test(combined) && combined.includes("ap run --stage"),
      `status=${run.status} out=${JSON.stringify(combined.slice(-500))}`);
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
