#!/usr/bin/env node
// Focused tests for backlog #39 (`ap run --mission` / planning-stage resume).
//
// Case groups (argv filter: `node scripts/test-run-mission-flag.mjs <group>`):
//   parse  — pure helper-level cases for `parseRunArgs()` (this file, task 1.1).
//   flag   — fixture-subprocess wiring cases for the `ap run` handler (task 1.2).
//   resume — fixture-subprocess planning-stage resume cases (task 1.3).
//
// The filter must match at least one case or the run fails (exit non-zero),
// so a typo'd filter can never pass vacuously. Any failing case also exits
// non-zero. With no filter (or `all`), every case runs.
import { parseRunArgs } from "./mission-naming.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, withoutOuterGitGuard, readObservedEvents, cleanup, skillRoot } from "./test-fixtures/workflow-order-harness.mjs";

const filter = process.argv[2] || "all";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

// Each case: {group, name, args, expect:{mission?, request?, error: null|"error"}}.
// `error: "error"` means any non-null error string is expected.
const CASES = [
  { group: "parse", name: "plain request passes through", args: ["do", "the", "thing"], expect: { mission: "", request: "do the thing", error: null } },
  { group: "parse", name: "empty args", args: [], expect: { mission: "", request: "", error: null } },
  { group: "parse", name: "--mission prefix stripped", args: ["--mission", "my-mission", "do", "the", "thing"], expect: { mission: "my-mission", request: "do the thing", error: null } },
  { group: "parse", name: "--mission suffix stripped", args: ["do", "the", "thing", "--mission", "my-mission"], expect: { mission: "my-mission", request: "do the thing", error: null } },
  { group: "parse", name: "--mission mid-args stripped", args: ["do", "--mission", "my-mission", "the", "thing"], expect: { mission: "my-mission", request: "do the thing", error: null } },
  { group: "parse", name: "--mission alone leaves empty request", args: ["--mission", "my-mission"], expect: { mission: "my-mission", request: "", error: null } },
  { group: "parse", name: "--repo stripped", args: ["do", "the", "thing", "--repo", "/tmp/x"], expect: { mission: "", request: "do the thing", error: null } },
  { group: "parse", name: "--mission and --repo both stripped", args: ["--mission", "my-mission", "do", "thing", "--repo", "/tmp/x"], expect: { mission: "my-mission", request: "do thing", error: null } },
  { group: "parse", name: "--mission missing value is a usage error", args: ["--mission"], expect: { error: "error" } },
  { group: "parse", name: "--mission trailing without value is a usage error", args: ["do", "thing", "--mission"], expect: { error: "error" } },
  { group: "parse", name: "--mission with flag-like value is a usage error", args: ["--mission", "--repo", "/tmp/x"], expect: { error: "error" } },
  { group: "parse", name: "--mission with flag-like value mid-args is a usage error", args: ["do", "thing", "--mission", "--verbose"], expect: { error: "error" } },
  { group: "parse", name: "residual request starting with -- is a usage error", args: ["--verbose", "do", "thing"], expect: { error: "error" } },
  { group: "parse", name: "lone residual flag is a usage error", args: ["--verbose"], expect: { error: "error" } },
  { group: "parse", name: "residual flag after valid --mission is a usage error", args: ["--mission", "my-mission", "--verbose"], expect: { error: "error" } },
  { group: "parse", name: "inline flag text inside request is kept", args: ["do", "--verbose", "thing"], expect: { mission: "", request: "do --verbose thing", error: null } },
];

// Spawns a real `node scripts/autopilot.mjs run ...` subprocess with an
// explicit argv tail (task 1.2 needs `--mission` placement control, which the
// harness's fixed `runAutopilot()` helper cannot express). Mirrors that
// helper's environment handling; the child works on a temp fixture repo.
function runWithArgs(repo, binDir, args, { timeoutMs = 120000 } = {}) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const base = withoutOuterGitGuard(process.env);
  delete base.AUTOPILOT_SPEC;
  const env = { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` };
  const result = spawnSync(process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", ...args, "--repo", repo],
    { cwd: repo, encoding: "utf8", env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], shell: false });
  return { status: result.status, timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"), stdout: result.stdout || "", stderr: result.stderr || "" };
}

function readFixtureState(repo) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  } catch {
    return null;
  }
}

// Flag-group fixture-subprocess cases (task 1.2, via workflow-order-harness).
// Each entry runs against a disposable fixture repo and reports via check().
function runFlagCases() {
  // Usage-error cases die before any relay, so they run on every platform.
  {
    const repo = makeFixtureRepo("flag-usage-flag-request");
    const binDir = makeFixtureBin("flag-usage-flag-request");
    try {
      writeConfig(repo, { planningFramework: "standalone" });
      const run = runWithArgs(repo, binDir, ["--verbose"], { timeoutMs: 60000 });
      const combined = `${run.stdout}\n${run.stderr}`;
      check("[flag] request starting with -- dies with a usage error",
        run.status !== 0 && /usage error/i.test(combined),
        `status=${run.status} out=${JSON.stringify(combined.slice(-500))}`);
    } finally {
      cleanup(repo, binDir);
    }
  }
  {
    const repo = makeFixtureRepo("flag-usage-mission-noval");
    const binDir = makeFixtureBin("flag-usage-mission-noval");
    try {
      writeConfig(repo, { planningFramework: "standalone" });
      const run = runWithArgs(repo, binDir, ["--mission"], { timeoutMs: 60000 });
      const combined = `${run.stdout}\n${run.stderr}`;
      check("[flag] bare --mission dies with a usage error",
        run.status !== 0 && /usage error/i.test(combined),
        `status=${run.status} out=${JSON.stringify(combined.slice(-500))}`);
    } finally {
      cleanup(repo, binDir);
    }
  }
  // Full-run override cases need the standalone read-only roles (bubblewrap
  // on Linux; see test-workflow-order-standalone.mjs for the Windows gap).
  if (process.platform === "win32") {
    check("[flag] mission-override subprocess cases skipped on win32 (no standalone containment)", true);
    return;
  }
  for (const [name, args, mission] of [
    ["prefix", ["--mission", "flag-mission-prefix", "implement", "the", "fixture", "task"], "flag-mission-prefix"],
    ["suffix", ["implement", "the", "fixture", "task", "--mission", "flag-mission-suffix"], "flag-mission-suffix"],
  ]) {
    const repo = makeFixtureRepo(`flag-${name}`);
    const binDir = makeFixtureBin(`flag-${name}`);
    try {
      writeConfig(repo, { planningFramework: "standalone" });
      setScenario(repo, "success");
      const run = runWithArgs(repo, binDir, args);
      const s = readFixtureState(repo);
      const missionDir = path.join(repo, ".autopilot", "missions", mission);
      const okStatus = run.status === 0;
      const okMission = s?.mission === mission;
      const okRequest = s?.planningRequest === "implement the fixture task";
      const okNoLeak = typeof s?.planningRequest === "string" && !s.planningRequest.includes("--mission") && !s.planningRequest.includes("--repo");
      const okDir = fs.existsSync(missionDir);
      const ok = okStatus && okMission && okRequest && okNoLeak && okDir;
      check(`[flag] --mission ${name} resolves override without leaking flag text into the request`,
        ok, `status=${run.status} mission=${JSON.stringify(s?.mission)} planningRequest=${JSON.stringify(s?.planningRequest)} dirExists=${okDir} stderrTail=${JSON.stringify((run.stderr || "").slice(-300))}`);
    } finally {
      cleanup(repo, binDir);
    }
  }
}

// Resume-group fixture-subprocess cases (task 1.3, via workflow-order-harness).
// A planning-stage stop is a state.json with a planning phase/step, a usable
// stored planningRequest, and `missing` planning artifacts (no mission dir).
// R1 runs bare `ap run` (no request args) against that stop and asserts the
// stored request drives planning: the fake planner role is observed, the
// mission dir slug derives from the STORED request, and s.planningRequest is
// unchanged (the bare-run placeholder is never recorded). R2/R3 assert
// completed/cancelled missions still die for a description on a bare run.
// R4 asserts genuinely new request text still starts a new mission.
const RESUME_STORED_REQUEST = "implement the fixture task";
const RESUME_STORED_MISSION = "001-implement-fixture-task";

function writeResumeState(repo, state) {
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
}

function runResumeCases() {
  // R2/R3 die before any relay, so they run on every platform.
  for (const phase of ["completed", "cancelled"]) {
    const repo = makeFixtureRepo(`resume-${phase}-bare`);
    const binDir = makeFixtureBin(`resume-${phase}-bare`);
    try {
      writeConfig(repo, { planningFramework: "standalone" });
      writeResumeState(repo, { version: 1, phase, step: "done", planningRequest: RESUME_STORED_REQUEST });
      const run = runWithArgs(repo, binDir, [], { timeoutMs: 60000 });
      const combined = `${run.stdout}\n${run.stderr}`;
      check(`[resume] bare ap run on a ${phase} mission dies for a description`,
        run.status !== 0 && /no open task|no feature description/i.test(combined),
        `status=${run.status} out=${JSON.stringify(combined.slice(-500))}`);
    } finally {
      cleanup(repo, binDir);
    }
  }
  // R1/R4 are full runs needing the standalone read-only roles (bubblewrap
  // on Linux; same Windows gap as the flag full-run cases above).
  if (process.platform === "win32") {
    check("[resume] planning-stage resume subprocess cases skipped on win32 (no standalone containment)", true);
    return;
  }
  // R1: bare `ap run` resumes the planning-stage stop with the stored request.
  {
    const repo = makeFixtureRepo("resume-bare-planning");
    const binDir = makeFixtureBin("resume-bare-planning");
    try {
      writeConfig(repo, { planningFramework: "standalone" });
      setScenario(repo, "success");
      writeResumeState(repo, { version: 1, phase: "planning", step: "standalone-plan", planningRequest: RESUME_STORED_REQUEST });
      const run = runWithArgs(repo, binDir, []);
      const s = readFixtureState(repo);
      const events = readObservedEvents(repo);
      const roles = events.map((e) => e.role);
      const plannerEvent = events.find((e) => e.role === "planner");
      let plannerBrief = "";
      try {
        plannerBrief = plannerEvent ? fs.readFileSync(path.join(path.dirname(plannerEvent.file), "brief.txt"), "utf8") : "";
      } catch {
        plannerBrief = "";
      }
      const missionDir = path.join(repo, ".autopilot", "missions", RESUME_STORED_MISSION);
      const okStatus = run.status === 0;
      const okPlanner = roles.includes("planner");
      const okPrompt = plannerBrief.includes(`Project request/context: ${RESUME_STORED_REQUEST}`)
        && !plannerBrief.includes("Use the current project request/context.");
      const okMission = s?.mission === RESUME_STORED_MISSION;
      const okUnchanged = s?.planningRequest === RESUME_STORED_REQUEST;
      const okDir = fs.existsSync(path.join(missionDir, "PLAN.md")) && fs.existsSync(path.join(missionDir, "TASKS.md"));
      const ok = okStatus && okPlanner && okPrompt && okMission && okUnchanged && okDir;
      check("[resume] bare ap run resumes the planning-stage stop with the stored request",
        ok, `status=${run.status} roles=${JSON.stringify(roles)} promptOk=${okPrompt} briefHasRequest=${plannerBrief.includes(RESUME_STORED_REQUEST)} mission=${JSON.stringify(s?.mission)} planningRequest=${JSON.stringify(s?.planningRequest)} dirOk=${okDir} stderrTail=${JSON.stringify((run.stderr || "").slice(-300))}`);
    } finally {
      cleanup(repo, binDir);
    }
  }
  // R4: new request text on the same stop starts a new mission.
  {
    const repo = makeFixtureRepo("resume-new-text");
    const binDir = makeFixtureBin("resume-new-text");
    try {
      writeConfig(repo, { planningFramework: "standalone" });
      setScenario(repo, "success");
      writeResumeState(repo, { version: 1, phase: "planning", step: "standalone-plan", planningRequest: RESUME_STORED_REQUEST });
      const run = runWithArgs(repo, binDir, ["implement", "a", "different", "fixture", "task"]);
      const s = readFixtureState(repo);
      const okStatus = run.status === 0;
      const okRequest = s?.planningRequest === "implement a different fixture task";
      const okNewMission = typeof s?.mission === "string" && s.mission !== RESUME_STORED_MISSION && /different-fixture-task/.test(s.mission);
      const okDir = typeof s?.mission === "string" && fs.existsSync(path.join(repo, ".autopilot", "missions", s.mission));
      const ok = okStatus && okRequest && okNewMission && okDir;
      check("[resume] new request text starts a new mission instead of resuming",
        ok, `status=${run.status} mission=${JSON.stringify(s?.mission)} planningRequest=${JSON.stringify(s?.planningRequest)} dirExists=${okDir} stderrTail=${JSON.stringify((run.stderr || "").slice(-300))}`);
    } finally {
      cleanup(repo, binDir);
    }
  }
}

const selected = filter === "all" ? CASES : CASES.filter((c) => c.group === filter);
// Fixture-subprocess groups live outside CASES (they spawn real `ap run`
// subprocesses instead of calling the pure helper).
const SUBPROCESS_GROUPS = ["flag", "resume"];
if (selected.length === 0 && !(SUBPROCESS_GROUPS.includes(filter) || filter === "all")) {
  console.error(`FAIL no cases matched filter "${filter}" (known groups: ${[...new Set(CASES.map((c) => c.group))].join(", ")}, ${SUBPROCESS_GROUPS.join(", ")})`);
  process.exit(1);
}

for (const c of selected) {
  let got;
  try {
    got = parseRunArgs(c.args);
  } catch (e) {
    check(`[${c.group}] ${c.name}`, false, `threw: ${e?.message || e}`);
    continue;
  }
  const shapeOk = got && typeof got === "object" && typeof got.mission === "string" && typeof got.request === "string" && (got.error === null || typeof got.error === "string");
  if (!shapeOk) {
    check(`[${c.group}] ${c.name}`, false, `bad shape: ${JSON.stringify(got)}`);
    continue;
  }
  const wantError = c.expect.error === "error";
  const errOk = wantError ? got.error !== null : got.error === null;
  const missionOk = c.expect.mission === undefined || got.mission === c.expect.mission;
  const requestOk = c.expect.request === undefined || got.request === c.expect.request;
  const ok = errOk && missionOk && requestOk;
  check(`[${c.group}] ${c.name}`, ok, ok ? "" : `args=${JSON.stringify(c.args)} got=${JSON.stringify(got)} want=${JSON.stringify(c.expect)}`);
}

if (filter === "flag" || filter === "all") runFlagCases();
if (filter === "resume" || filter === "all") runResumeCases();

console.log(failed ? `${failed} of ${ran} case(s) failed (filter "${filter}").` : `all ${ran} case(s) passed (filter "${filter}").`);
process.exit(failed ? 1 : 0);
