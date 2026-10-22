#!/usr/bin/env node
// TASK-26 (003#5 part b) — code_reviewer/verifier kill deadlines derived
// from measured run durations instead of the fixed relay_timeout_ms guess.
//
// Part 1 (pure, every platform): deriveRoleDeadline's four rules and their
// order, the floor/ceiling clamps, and newest-10 windowing; collectRoleSamples
// over temp runs dirs (inclusion/exclusion, newest-first order, the
// current-mission-first → repo-wide fallback); readRunMeta exposing
// duration_ms with existing fields unchanged; a grep-level pin that planner,
// plan_reviewer and GSD relays still get timeoutMs null.
//
// Part 2 (behavioural): real `node scripts/autopilot.mjs run` missions on
// the "success" fixture (single-task phase, instant PASS reviews). The
// mission's runs dir is seeded with prior completed verifier/code_reviewer
// status.json samples (future started_at so they stay newest-first ahead of
// the mission's own runs):
// - seeded: reviewer/verifier briefs carry the Time budget line with the
//   expected derived HH:MM:SS, and their status.json timeout_ms equals it;
// - unseeded: the default line and timeout == relay_timeout_ms.
// The seeded case runs on both loops; the default case runs on Speckit only.
//
// Part 3 (safety valve, Speckit only): seeded samples plus the test-only
// policy.role_deadline_floor_ms force a 4s verifier deadline while the
// fake-adapter verifier sleeps 20s. The first attempt ends TIMEOUT, the
// retry runs at relay_timeout_ms, and roleDeadlineBreached is cleared after
// the retry completes.
//
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveRoleDeadline, collectRoleSamples,
  ROLE_DEADLINE_FLOOR_MS, ROLE_DEADLINE_MULTIPLIER,
} from "./role-deadline.mjs";
import {readRunMeta} from "./run-history.mjs";
import {resolveStandaloneMission} from "./mission-naming.mjs";
import * as standalone from "../adapters/standalone.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const REQUEST = "role deadline fixture request";
const RUN_TIMEOUT_MS = 240000;
const RELAY_DEFAULT_MS = 200 * 60 * 1000;
// Seeded reviewer samples (newest last here): longest 10min → ×2 = 20min.
const REVIEWER_KILL = "00:20:00";
const REVIEWER_KILL_MS = 20 * 60 * 1000;
// The shipped verifier timeout default (180min) is below the 200min call
// backstop, so it is an explicit policy override and wins over the seeded
// measured samples.
const VERIFIER_KILL = "03:00:00";
const VERIFIER_KILL_MS = 180 * 60 * 1000;

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}
function skips(name, why) {
  console.log(`SKIP ${name} — ${why}`);
}

// ══════════════════════════════════════════════════════════════════════
// 1. deriveRoleDeadline: rules, order, clamps, windowing.
// ══════════════════════════════════════════════════════════════════════
{
  const relay = RELAY_DEFAULT_MS;
  const d = (ms) => deriveRoleDeadline({samplesMs: [600000, 300000], relayTimeoutMs: relay});
  check("derive: measured is longest(newest 10) × 2",
    d().timeoutMs === 1200000 && d().source === "measured" &&
    d().sampleCount === 2 && d().longestMs === 600000 && d().lastMs === 600000, d());

  check("derive: no samples is today's default",
    deriveRoleDeadline({samplesMs: [], relayTimeoutMs: relay}).timeoutMs === relay &&
    deriveRoleDeadline({samplesMs: [], relayTimeoutMs: relay}).source === "default");

  check("derive: override wins and is returned as policy",
    deriveRoleDeadline({samplesMs: [600000], relayTimeoutMs: relay, override: 60000}).timeoutMs === 60000 &&
    deriveRoleDeadline({samplesMs: [600000], relayTimeoutMs: relay, override: 60000}).source === "policy");

  check("derive: override beats breach",
    deriveRoleDeadline({samplesMs: [600000], relayTimeoutMs: relay, override: 60000, breached: true}).source === "policy");

  check("derive: breach beats measured",
    deriveRoleDeadline({samplesMs: [600000], relayTimeoutMs: relay, breached: true}).timeoutMs === relay &&
    deriveRoleDeadline({samplesMs: [600000], relayTimeoutMs: relay, breached: true}).source === "breach-fallback");

  check("derive: floor clamp lifts a short sample",
    deriveRoleDeadline({samplesMs: [60000], relayTimeoutMs: relay}).timeoutMs === ROLE_DEADLINE_FLOOR_MS);

  check("derive: ceiling clamp caps a heavy outlier at today's value",
    deriveRoleDeadline({samplesMs: [3 * 60 * 60 * 1000], relayTimeoutMs: relay}).timeoutMs === relay);

  check("derive: an override above the ceiling is clamped to it",
    deriveRoleDeadline({samplesMs: [], relayTimeoutMs: relay, override: relay * 4}).timeoutMs === relay);

  const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 3 * 60 * 60, 3 * 60 * 60].map((s) => s * 1000);
  const w = deriveRoleDeadline({samplesMs: twelve, relayTimeoutMs: relay});
  // Newest 10 are 1s..10s (longest 10s → ×2 = 20s, lifted by the floor to
  // 10min). If the two huge oldest counted, the ceiling (200min) would win.
  check("derive: only the newest 10 samples count (two huge oldest ignored)",
    w.timeoutMs === ROLE_DEADLINE_FLOOR_MS && w.sampleCount === 10 && w.longestMs === 10000, w);

  check("derive: constants are the documented floor and multiplier",
    ROLE_DEADLINE_FLOOR_MS === 10 * 60 * 1000 && ROLE_DEADLINE_MULTIPLIER === 2);
}

// ══════════════════════════════════════════════════════════════════════
// 2. collectRoleSamples over temp runs dirs.
// ══════════════════════════════════════════════════════════════════════
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-role-deadline-"));
  try {
    const primary = path.join(root, "missions", "current", "runs");
    const fallback = path.join(root, "missions", "older", "runs");
    const put = (dir, name, status) => {
      fs.mkdirSync(path.join(dir, name), {recursive: true});
      fs.writeFileSync(path.join(dir, name, "status.json"), JSON.stringify(status));
    };
    // Primary: one good sample, plus every exclusion shape.
    put(primary, "01-code_reviewer-aaaabbbb", {status: "completed", role: "code_reviewer", started_at: "2026-01-01T00:00:00+00:00", exit_code: 0, duration_ms: 5000});
    put(primary, "02-code_reviewer-ccccdddd", {status: "failed", role: "code_reviewer", started_at: "2026-01-01T00:01:00+00:00", exit_code: 1, duration_ms: 9000});
    put(primary, "03-code_reviewer-eeeeffff", {status: "capped", role: "code_reviewer", started_at: "2026-01-01T00:02:00+00:00", exit_code: null, duration_ms: 9000});
    put(primary, "04-code_reviewer-11112222", {status: "running", role: "code_reviewer", started_at: "2026-01-01T00:03:00+00:00", exit_code: null, duration_ms: 9000});
    put(primary, "05-code_reviewer-33334444", {status: "completed", role: "code_reviewer", started_at: "2026-01-01T00:04:00+00:00", exit_code: 0});
    put(primary, "06-verifier-55556666", {status: "completed", role: "verifier", started_at: "2026-01-01T00:05:00+00:00", exit_code: 0, duration_ms: 7000});
    put(primary, "07-code_reviewer-77778888", {status: "completed", role: "code_reviewer", started_at: "2026-01-01T00:06:00+00:00", exit_code: 0, duration_ms: -5});
    put(primary, "08-code_reviewer-99990000", {status: "completed", role: "code_reviewer", started_at: "2026-01-01T00:07:00+00:00", exit_code: 0, duration_ms: 8000});
    fs.mkdirSync(path.join(primary, "09-code_reviewer-nostatus"), {recursive: true});
    put(fallback, "01-code_reviewer-ffff0000", {status: "completed", role: "code_reviewer", started_at: "2026-01-01T00:08:00+00:00", exit_code: 0, duration_ms: 60000});

    const got = collectRoleSamples(primary, "code_reviewer", [fallback]);
    check("collect: only clean completed samples, newest-first",
      JSON.stringify(got) === JSON.stringify([8000, 5000]), got);

    const empty = collectRoleSamples(path.join(root, "missions", "empty", "runs"), "code_reviewer", [fallback]);
    check("collect: empty primary falls back repo-wide",
      JSON.stringify(empty) === JSON.stringify([60000]), empty);

    const none = collectRoleSamples(path.join(root, "missions", "empty", "runs"), "code_reviewer", [path.join(root, "missions", "absent", "runs")]);
    check("collect: no samples anywhere is [] (derives the default)",
      JSON.stringify(none) === JSON.stringify([]), none);

    const otherRole = collectRoleSamples(primary, "verifier", [fallback]);
    check("collect: role filter is exact",
      JSON.stringify(otherRole) === JSON.stringify([7000]), otherRole);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. readRunMeta exposes duration_ms; existing fields unchanged.
// ══════════════════════════════════════════════════════════════════════
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-run-meta-"));
  try {
    const runDir = path.join(dir, "01-code_reviewer-abcdef12");
    fs.mkdirSync(runDir, {recursive: true});
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
      status: "completed", role: "code_reviewer", started_at: "2026-01-01T00:00:00+00:00",
      exit_code: 0, duration: "00:00:05", duration_ms: 5000, run_id: "r1",
    }));
    const meta = readRunMeta(runDir, "01-code_reviewer-abcdef12");
    check("meta: duration_ms is exposed",
      meta.duration_ms === 5000, meta.duration_ms);
    check("meta: existing fields are unchanged",
      meta.role === "code_reviewer" && meta.status === "completed" &&
      meta.exit_code === 0 && meta.duration === "00:00:05" && meta.id === "r1", meta);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. Regression pin: planner, plan_reviewer and GSD relays still get
// timeoutMs null (only verifier relayAsync calls carry a deadline; the two
// implementer relay() calls keep their own per-task deadline, as before).
// ══════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("pin: relayAsync forwards timeoutMs to runRelay",
    /timeoutMs,alwaysSave:true/.test(src));
  const asyncWith = new Set();
  for (const m of src.matchAll(/relayAsync\(\s*"([^"]+)"/g)) {
    if (/timeoutMs/.test(src.slice(m.index, m.index + 1200))) asyncWith.add(m[1]);
  }
  check("pin: only verifier relayAsync calls pass timeoutMs (GSD/planner/plan_reviewer unchanged)",
    asyncWith.size === 1 && asyncWith.has("verifier"), [...asyncWith]);
  check("pin: reviewers never go through relay() directly (review()/relayAsync() carry the deadline)",
    !/relay\(\s*"code_reviewer"/.test(src) && !/relay\(\s*"verifier"/.test(src));
  const plannerWindow = src.slice(src.indexOf('relay("planner"'), src.indexOf('relay("planner"') + 600);
  check("pin: the planner relay() passes no timeoutMs",
    !/timeoutMs/.test(plannerWindow), plannerWindow.slice(0, 120));
}

// ══════════════════════════════════════════════════════════════════════
// 5-6. Behavioural helpers.
// ══════════════════════════════════════════════════════════════════════
function writeDeadlineStandaloneMission(repo) {
  const mission = "001-role-deadline";
  const planFile = standalone.planPath(repo, mission);
  const tasksFile = standalone.tasksPath(repo, mission);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(tasksFile, ["## Phase 1: General", "", "- [ ] Do the deadline fixture task", ""].join("\n"));
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission, planningRequest: "fixture request",
  }));
  return {planFile, tasksFile};
}

function speckitDeadlineTasksFile(repo) {
  const specsDir = path.join(repo, "specs");
  const matches = [];
  for (const entry of fs.readdirSync(specsDir)) {
    const candidate = path.join(specsDir, entry, "tasks.md");
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one SpecKit tasks.md, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

// Hand-written prior samples under a foreign mission bucket: the current
// mission's runs dir has no reviewer/verifier samples yet, so the repo-wide
// fallback finds these. Future started_at keeps them newest-first ahead of
// the mission's own runs, making the derived numbers exact.
function seedPriorSamples(repo, reviewer, verifier) {
  const root = path.join(repo, ".autopilot", "missions", "seeded-prior", "runs");
  const put = (role, index, {at, ms}) => {
    const dir = path.join(root, `0${index}-${role}-seed${index}0000`);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      status: "completed", role, started_at: at, exit_code: 0, duration_ms: ms,
    }));
  };
  reviewer.forEach((sample, i) => put("code_reviewer", i + 1, sample));
  verifier.forEach((sample, i) => put("verifier", i + 3, sample));
}

function roleEvents(repo, role) {
  return readObservedEvents(repo).filter((e) => e.role === role);
}
function briefOf(event) {
  try { return fs.readFileSync(path.join(path.dirname(event.file), "brief.txt"), "utf8"); }
  catch { return ""; }
}
function statusOf(event) {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(event.file), "status.json"), "utf8")); }
  catch { return null; }
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

const REVIEWER_SEEDS = [
  {at: "2030-01-01T00:00:00+00:00", ms: 600000},
  {at: "2030-01-01T00:01:00+00:00", ms: 300000},
];
const VERIFIER_SEEDS = [
  {at: "2030-01-01T00:00:00+00:00", ms: 900000},
  {at: "2030-01-01T00:01:00+00:00", ms: 120000},
];

// Seeded e2e, both loops: exact derived numbers in the briefs and in
// status.json timeout_ms.
async function runSeededCase(label, framework) {
  const tag = `${label}/deadline-seeded`;
  const repo = makeFixtureRepo(`rd-${framework}-seeded`);
  const binDir = makeFixtureBin(`rd-${framework}-seeded`);
  try {
    let request = REQUEST;
    let tasksFile = null;
    if (framework === "speckit") {
      makeSpecKitWorkflowOnly(repo);
      makeClaudeMdBaseline(repo);
    } else {
      request = "fixture request";
    }
    writeConfig(repo, {planningFramework: framework});
    setScenario(repo, "success");
    if (framework !== "speckit") ({tasksFile} = writeDeadlineStandaloneMission(repo));
    seedPriorSamples(repo, REVIEWER_SEEDS, VERIFIER_SEEDS);

    const run = runAutopilot(repo, binDir, {request, timeoutMs: RUN_TIMEOUT_MS});
    if (framework === "speckit") tasksFile = speckitDeadlineTasksFile(repo);
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    check(`${tag}: the run completes the phase (exit 0, every checkbox marked)`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;

    const reviews = roleEvents(repo, "code_reviewer");
    const verifies = roleEvents(repo, "verifier");
    check(`${tag}: a phase code review and a verifier ran`,
      reviews.length >= 1 && verifies.length >= 1, {reviews: reviews.length, verifies: verifies.length});
    if (!reviews.length || !verifies.length) return;

    const reviewBrief = briefOf(reviews[0]);
    check(`${tag}: the reviewer brief carries the derived 20min budget line`,
      reviewBrief.includes(`Time budget: this run is killed at ${REVIEWER_KILL}`), reviewBrief.slice(0, 300));
    check(`${tag}: the reviewer brief shows the measured numbers`,
      reviewBrief.includes("took 00:05:00 (longest of the last 2: 00:10:00)"), reviewBrief.slice(0, 400));
    check(`${tag}: the reviewer relay received that timeoutMs`,
      statusOf(reviews[0])?.timeout_ms === REVIEWER_KILL_MS, statusOf(reviews[0])?.timeout_ms);

    const verifyBrief = briefOf(verifies[0]);
    check(`${tag}: the verifier brief carries the configured 180min budget line`,
      verifyBrief.includes(`Time budget: this run is killed at ${VERIFIER_KILL}`), verifyBrief.slice(0, 300));
    check(`${tag}: the verifier brief shows the measured numbers`,
      verifyBrief.includes("took 00:02:00 (longest of the last 2: 00:15:00)"), verifyBrief.slice(0, 400));
    check(`${tag}: the verifier relay received that timeoutMs`,
      statusOf(verifies[0])?.timeout_ms === VERIFIER_KILL_MS, statusOf(verifies[0])?.timeout_ms);
  } finally {
    cleanup(repo, binDir);
  }
}

// Default e2e, Speckit only: no seeds anywhere. The phase reviewer (no
// per-role override) gets the default line and the call backstop. The
// verifier gets the shipped 180-minute verifier default. The mission-final
// review is only pinned to carry a Time budget line at all — it legitimately
// sees the mission's own phase review as a measured sample.
async function runDefaultCase() {
  const tag = "speckit/deadline-default";
  const repo = makeFixtureRepo("rd-default");
  const binDir = makeFixtureBin("rd-default");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "success");

    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RUN_TIMEOUT_MS});
    const tasksText = fs.readFileSync(speckitDeadlineTasksFile(repo), "utf8");
    check(`${tag}: the run completes the phase`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;

    const phaseReviews = roleEvents(repo, "code_reviewer").filter((e) => /^Phase: /m.test(briefOf(e)));
    const verifies = roleEvents(repo, "verifier");
    check(`${tag}: a phase review and a verifier ran`,
      phaseReviews.length >= 1 && verifies.length >= 1, {reviews: phaseReviews.length, verifies: verifies.length});
    if (!phaseReviews.length || !verifies.length) return;
    check(`${tag}: the phase review shows the default line`,
      briefOf(phaseReviews[0]).includes("Time budget: this run is killed at 03:20:00. No measured code_reviewer run exists yet."),
      briefOf(phaseReviews[0]).slice(0, 300));
    check(`${tag}: the phase review relay got relay_timeout_ms`,
      statusOf(phaseReviews[0])?.timeout_ms === RELAY_DEFAULT_MS, statusOf(phaseReviews[0])?.timeout_ms);
    check(`${tag}: the verifier shows the configured default line`,
      briefOf(verifies[0]).includes("Time budget: this run is killed at 03:00:00. No measured verifier run exists yet."),
      briefOf(verifies[0]).slice(0, 300));
    check(`${tag}: the verifier relay got the verifier default`,
      statusOf(verifies[0])?.timeout_ms === VERIFIER_KILL_MS, statusOf(verifies[0])?.timeout_ms);
  } finally {
    cleanup(repo, binDir);
  }
}

// Safety valve, Speckit only: tiny derived verifier deadline (seeds
// 2000/1000ms + test-only floor 1000ms → longest 2000 × 2 = 4000ms) with a
// verifier that sleeps 20s. Attempt 1 ends TIMEOUT; the retry runs at the
// relay ceiling and completes; the breach flag is cleared afterwards.
async function runBreachCase() {
  const tag = "speckit/deadline-breach";
  const repo = makeFixtureRepo("rd-breach");
  const binDir = makeFixtureBin("rd-breach");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    // Test-only floor override (documented as such in autopilot.mjs). The
    // shipped 180-minute verifier default would mask the tiny derived
    // deadline, so the fixture disables that override for this case.
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.policy = {
      ...(config.policy ?? {}),
      role_deadline_floor_ms: 1000,
      role_timeout_ms: {verifier: null},
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "role_deadline_breach");
    seedPriorSamples(repo, REVIEWER_SEEDS, [
      {at: "2030-01-01T00:00:00+00:00", ms: 2000},
      {at: "2030-01-01T00:01:00+00:00", ms: 1000},
    ]);

    const run = runAutopilot(repo, binDir, {request: REQUEST, timeoutMs: RUN_TIMEOUT_MS});
    const tasksText = fs.readFileSync(speckitDeadlineTasksFile(repo), "utf8");
    check(`${tag}: the run completes after the retry (exit 0, every checkbox marked)`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;

    const verifies = roleEvents(repo, "verifier");
    check(`${tag}: the verifier ran twice (timeout, then retry)`,
      verifies.length === 2, verifies.length);
    if (verifies.length !== 2) return;
    const readResult = (e) => {
      try { return JSON.parse(fs.readFileSync(e.file, "utf8")); }
      catch { return null; }
    };
    check(`${tag}: the first attempt ended TIMEOUT`,
      readResult(verifies[0])?.failure?.class === "TIMEOUT", readResult(verifies[0])?.failure);
    check(`${tag}: the first attempt ran under the tiny 4s derived deadline`,
      statusOf(verifies[0])?.timeout_ms === 4000, statusOf(verifies[0])?.timeout_ms);
    check(`${tag}: the retry ran at the relay ceiling`,
      statusOf(verifies[1])?.timeout_ms === RELAY_DEFAULT_MS, statusOf(verifies[1])?.timeout_ms);
    const state = readState(repo);
    check(`${tag}: roleDeadlineBreached is cleared after the retry completes`,
      state.roleDeadlineBreached?.verifier == null, state.roleDeadlineBreached);
  } finally {
    cleanup(repo, binDir);
  }
}

await runSeededCase("speckit", "speckit");
await runDefaultCase();
await runBreachCase();

await runSeededCase("standalone", "standalone");

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
