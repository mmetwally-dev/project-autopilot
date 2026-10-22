#!/usr/bin/env node
// Backlog 003#15 (token ceiling) + 003#16 (turn cap) + 003#17 (continuation):
// live cap-breach → kill → continuation → relaunch coverage through real
// `node scripts/autopilot.mjs run` subprocesses (never by importing
// autopilot.mjs — it runs main() at import).
//
// The implementer runs on the opencode adapter id via a PATH shim around
// test-fixtures/fake-cap-breach-adapter.mjs (real NDJSON step_finish, so the
// production decoder and accumulateUsage() observe turns/tokens). Everything
// else stays on the shared cursor fixture. Only implementer relays ever
// launch — the mission always ends at the first read-only role (bubblewrap
// is unavailable here), so no platform SKIP is needed: assertions target
// implementer run dirs and state.json, never review verdicts.
//
// Scenarios (policy goes through the validated config surface):
//   S1 turn breach  — 45 slow tiny-token turns vs per_task_max_turns 5:
//        killed → the orchestrator writes the fallback note from the
//        session-only changes + session digest (mission 045: NO wrap-up resume
//        turn exists anymore) → relaunched → generation 2 completes
//        (brief shows the fallback note above the digest).
//   S2 wrap-up trigger — 45 slow token-heavy turns (2M per-turn context) vs
//        per_task_max_tokens 3M (turn cap 1000 to isolate): stopped at the
//        160K wrap-up threshold (not the 3M cap) → orchestrator fallback
//        note → gen-2 completes.
//   S3 exhaustion   — always-spin + continuation_allowance 1: two breaches
//        (each recorded as orchestrator_fallback), then
//        standalone_task_not_converging escalation (self-terminating).
//   S5 missing-note fallback — cap_wrapup_silent never writes any note:
//        wrapUp.status orchestrator_fallback / note_missing_or_stale with
//        the fallback note written at the hand-off path, gen-2 completes
//        with that note above the digest.
//   S6 no-session fallback — cap_nosid emits no session id: with the resume
//        path gone there is nothing to resume regardless, and the
//        orchestrator fallback (not the stale agent note) is what gen-2
//        renders, then completes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot,
  readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {resolveAgentBinary} from "./agent-process.mjs";
import {
  resolvePerRoleLimits,
  resolveHandoffWrapupTokens,
  checkWrapupTrigger,
  PER_ROLE_WRAPUP_TOKENS_DEFAULT,
} from "./per-task-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAP_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");

// Hermetic-binary gate: the opencode adapter id must resolve to a fixture
// shim, never a real installed binary. On win32 a real opencode.exe
// outscores any .cmd shim, so this file SKIPs there when that happens
// (learned 2026-09-23) — same SKIP contract as the other platform-gated
// suites. The in-scenario sessionID tripwire below remains as defense in
// depth: a resolution surprise fails loudly, never silently.
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cap-probe-"));
  try {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(probeDir, "opencode.cmd"), "@echo off\r\necho probe\r\n");
    } else {
      const shim = path.join(probeDir, "opencode");
      fs.writeFileSync(shim, "#!/bin/sh\necho probe\n");
      fs.chmodSync(shim, 0o755);
    }
    const savedPath = process.env.PATH || "";
    process.env.PATH = probeDir + (process.platform === "win32" ? ";" : ":") + savedPath;
    let resolved = null;
    try { resolved = resolveAgentBinary("opencode"); } catch { resolved = null; }
    process.env.PATH = savedPath;
    const wins = typeof resolved === "string" &&
      path.resolve(resolved).toLowerCase().startsWith(path.resolve(probeDir).toLowerCase());
    if (!wins) {
      console.log(`test-cap-breach-rollover: SKIP — a real opencode binary (${resolved}) outscores the fixture shim on this machine; cap-breach e2e needs hermetic binary resolution.`);
      process.exit(0);
    }
  } finally {
    try { fs.rmSync(probeDir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}
const MISSION = "001-cap-breach";
const TASKS = "## Phase 1: General\n\n- [ ] Do the fixture task\n";
const AP_TIMEOUT_MS = 100000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function setupCapMission(prefix, scenario, policyExtra = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"),
      `@echo off\r\n"${process.execPath}" "${CAP_FIXTURE}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    const shim = path.join(binDir, "opencode");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CAP_FIXTURE}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  writeConfig(repo, {planningFramework: "standalone"});
  const configFile = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.roles.implementer.adapter = "opencode";
  config.policy = {
    ...config.policy,
    per_task_timeout_ms: 60000,
    ...policyExtra,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  setScenario(repo, scenario);
  const planFile = path.join(repo, ".autopilot", "missions", MISSION, "PLAN.md");
  const tasksFile = path.join(repo, ".autopilot", "missions", MISSION, "TASKS.md");
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: cap-breach probe.\n");
  fs.writeFileSync(tasksFile, TASKS);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission: MISSION, planningRequest: "cap probe",
  }, null, 2));
  return {repo, binDir};
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}

function implementerRuns(repo) {
  return readObservedEvents(repo)
    .filter((e) => e.role === "implementer")
    .map((e) => ({...e, data: JSON.parse(fs.readFileSync(e.file, "utf8"))}));
}

function briefText(repo, run) {
  try {
    return fs.readFileSync(path.join(path.dirname(run.file), "brief.txt"), "utf8");
  } catch { return null; }
}

// Mission 045: the note section the NEXT generation's brief renders for the
// previous one. By the time a scenario asserts, the run is over and task
// completion has removed the note from disk — but its text is embedded
// verbatim under this heading in the next brief, which is what a reader
// of this suite can still pin. The boundary is the next BRIEF section, not
// the next "## " — the fallback note carries its own "## Changes made in this
// session" / "## Session work digest" subsections that must stay inside.
function noteSectionOf(brief) {
  if (!brief) return "";
  const marker = "## Hand-off note from the previous session";
  const start = brief.indexOf(marker);
  if (start < 0) return "";
  const rest = brief.slice(start + marker.length);
  const boundaries = [
    "\n## Code the hand-off note cites",
    "\n## Dead ends from capped generations",
    "\n## Hand-off note (keep it current)",
    "\n## Worktree access",
  ];
  const ends = boundaries.map((b) => rest.indexOf(b)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : -1;
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function progressText(repo, run) {
  try {
    return fs.readFileSync(path.join(path.dirname(run.file), "progress.log"), "utf8");
  } catch { return ""; }
}

function statusOf(repo, run) {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(run.file), "status.json"), "utf8"));
  } catch { return null; }
}

function continuationKey(state) {
  return Object.keys(state.continuationBudgets || {})
    .find((k) => k.startsWith("continuationAllowance:task:standalone:phase-0:"));
}

// Mission 045: split implementer runs into task generations and wrap-up
// turns (`note: "wrap-up"` in status.json). The wrap-up resume is GONE, so
// the wrapups array is always empty — every scenario pins that as a
// negative (a resurrected resume run would break the count checks anyway).
function splitGenerations(repo, impls) {
  const wrapups = impls.filter((r) => statusOf(repo, r)?.note === "wrap-up");
  const generations = impls.filter((r) => statusOf(repo, r)?.note !== "wrap-up");
  return {wrapups, generations};
}

// ── S1: turn breach → kill → orchestrator fallback note → gen-2 completes ──
{
  const {repo, binDir} = setupCapMission("cap-s1", "cap_turns", {per_task_max_turns: 5});
  try {
    runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    // Hermetic-binary tripwire: the fixture never emits capital `sessionID`;
    // the real opencode CLI always does. If binary resolution ever loses to a
    // real installed .exe again, this fails loudly instead of downstream
    // asserts going confusingly red (learned 2026-09-23: opencode.exe
    // outscores any .cmd shim, so this file must run where no real opencode
    // wins). The fixture's own lowercase `session_id` is expected below.
    const gen1out = (() => { try { return fs.readFileSync(path.join(path.dirname(impls[0]?.file || ""), "stdout.log"), "utf8"); } catch { return ""; } })();
    check("s1: generation 1 ran the fixture binary (no sessionID in stdout)", !gen1out.includes("sessionID"), gen1out.slice(0, 200));
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s1: breach produced gen-1, then gen-2 — no wrap-up run (two implementer runs)",
      impls.length === 2 && generations.length === 2 && wrapups.length === 0, impls.length);
    const gen1 = generations[0]?.data;
    check("s1: generation 1 capped on turns with the wrap-up flag",
      gen1?.capped?.type === "turns" && gen1.capped.used > 5 && gen1.capped.limit === 5
      && gen1.capped.wrapUp === true && gen1.capped.trigger === "turns", gen1?.capped);
    check("s1: generation 1 recorded the fixture session id",
      gen1?.sessionId === "fixture-cap-session", gen1?.sessionId);
    check("s1: generation 1 did not complete", gen1?.status !== "completed", gen1?.status);
    const gen1status = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(generations[0]?.file || ""), "status.json"), "utf8")).status; } catch { return null; } })();
    check("s1: generation 1 reports capped, not failed", gen1status === "capped", gen1status);
    check("s1: breach observed to progress", progressText(repo, generations[0]).includes("CAP_BREACH | TYPE=turns"));
    check("s1: capped gen-1 recorded the orchestrator fallback (never a resumed session)",
      gen1?.wrapUp?.status === "orchestrator_fallback" && gen1?.wrapUp?.reason === "note_missing_or_stale"
      && gen1?.wrapUp?.fallbackNote === true && typeof gen1?.wrapUp?.note === "string", gen1?.wrapUp);
    check("s1: wrap-up outcome observed to progress (fallback, no resume)",
      progressText(repo, generations[0]).includes("WRAP_UP | STATUS=orchestrator_fallback")
      && progressText(repo, generations[0]).includes("REASON=note_missing_or_stale")
      && progressText(repo, generations[0]).includes("PATH=orchestrator_fallback"),
      progressText(repo, generations[0]).slice(-200));
    check("s1: generation 2 completed", generations[1]?.data?.status === "completed", generations[1]?.data?.status);
    check("s1: generation 2 prompt carried the dead-ends transfer",
      (briefText(repo, generations[1]) || "").includes("Dead ends from capped generations"));
    // Backlog #22: generation 2's brief shows what generation 1
    // read/searched/ran (decoded-events digest), never raw NDJSON.
    const gen2DeadLines = (briefText(repo, generations[1]) || "").split("\n").filter((l) => l.startsWith("- Generation"));
    check("s1: generation 2 brief carries the work digest (reads + commands)",
      gen2DeadLines.some((l) => l.includes("read: TASKS.md:1-20") && l.includes("ran: git status --short (ok)")), gen2DeadLines);
    check("s1: generation 2 brief has no raw JSON-event tail",
      gen2DeadLines.length > 0 && gen2DeadLines.every((l) => !l.includes("messageID") && !l.includes('"type":') && !l.includes("step_finish")), gen2DeadLines.map((l) => l.slice(0, 120)));
    check("s1: generation 1 result carries workDigest off finalMessage",
      typeof gen1?.workDigest === "string" && gen1.workDigest.includes("ran: git status --short (ok)")
      && !gen1.workDigest.includes("messageID"), (gen1?.workDigest || "").slice(0, 200));
    // Backlog #26 Step A + mission 045 + backlog #15 part 2: gen-1 kept a
    // STALE note at the path its own brief named (the fixture backdates it
    // by 10 minutes); the orchestrator writes the fallback note (worktree
    // diff + session work digest) and KEEPS the stale model note below it
    // under the "Previous note (written by the model)" heading — a real
    // model note is never destroyed by the fallback. Gen-2's brief renders
    // the merged note ABOVE the digest, and completion removed the note so
    // no later attempt inherits it. The per-task session store is removed
    // with it.
    const gen1NotePath = (/Keep a hand-off note at (\S+)/.exec(briefText(repo, generations[0]) || "") || [])[1]?.replace(/[.,;:]+$/, "");
    check("s1: gen-1 brief named its hand-off note path", typeof gen1NotePath === "string" && gen1NotePath.endsWith(".md"), gen1NotePath);
    const gen2Brief = briefText(repo, generations[1]) || "";
    const gen2Note = noteSectionOf(gen2Brief);
    check("s1: orchestrator fallback note kept the stale model note at the hand-off path",
      gen2Note.includes("(orchestrator fallback)")
      && gen2Note.includes("## Previous note (written by the model)")
      && gen2Note.includes("GEN1-HANDOFF-MARKER"), gen2Note.slice(0, 400));
    check("s1: the rendered note is the orchestrator's (diff + digest, not the agent's)",
      gen2Note.includes("## Changes made in this session")
      && gen2Note.includes("## Session work digest"), gen2Note.slice(0, 200));
    check("s1: generation 2 brief renders the orchestrator fallback above the digest",
      gen2Brief.includes("## Hand-off note from the previous session")
      && gen2Brief.includes("orchestrator fallback")
      && gen2Brief.indexOf("## Hand-off note from the previous session") < gen2Brief.indexOf("## Dead ends from capped generations"),
      gen2Brief.slice(0, 300));
    check("s1: hand-off note removed after the task completed",
      gen1NotePath ? !fs.existsSync(path.join(repo, gen1NotePath)) : false, gen1NotePath);
    check("s1: session store recorded on the run and removed after completion",
      typeof gen1?.sessionStore === "string" && gen1.sessionStore.includes("/sessions/")
      && !fs.existsSync(path.join(repo, gen1.sessionStore)), gen1?.sessionStore);
    const state = readState(repo);
    check("s1: continuation ledger clean after task success (cleared on commit)",
      continuationKey(state) === undefined, Object.keys(state.continuationBudgets || {}));
    check("s1: breach never touched implementation failure budgets",
      Object.keys(state.failureBudgets || {}).filter((k) => k.startsWith("implementationFailureBudget")).length === 0,
      state.failureBudgets);
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── S2: fixed-token wrap-up trigger (160K per-turn context, below the 3M cap) ──
{
  const {repo, binDir} = setupCapMission("cap-s2", "cap_tokens", {per_task_max_turns: 1000, per_task_max_tokens: 3000000});
  try {
    runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s2: wrap-up trigger produced gen-1, then gen-2 — no wrap-up run (two runs)",
      impls.length === 2 && generations.length === 2 && wrapups.length === 0, impls.length);
    const gen1 = generations[0]?.data;
    check("s2: generation 1 stopped at the 160K wrap-up threshold, not the 3M cap",
      gen1?.capped?.type === "tokens" && gen1.capped.used >= 160000 && gen1.capped.limit === 160000
      && gen1.capped.wrapUp === true && gen1.capped.trigger === "tokens", gen1?.capped);
    check("s2: capped generation recorded the orchestrator fallback note",
      gen1?.wrapUp?.status === "orchestrator_fallback" && gen1?.wrapUp?.reason === "note_missing_or_stale"
      && gen1?.wrapUp?.fallbackNote === true, gen1?.wrapUp);
    check("s2: generation 2 completed", generations[1]?.data?.status === "completed", generations[1]?.data?.status);
    const s2gen1status = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(generations[0]?.file || ""), "status.json"), "utf8")).status; } catch { return null; } })();
    check("s2: generation 1 reports capped, not failed", s2gen1status === "capped", s2gen1status);
    check("s2: breach never touched implementation failure budgets",
      Object.keys(readState(repo).failureBudgets || {}).filter((k) => k.startsWith("implementationFailureBudget")).length === 0);
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── S3: allowance exhaustion escalates as not-converging ──
{
  const {repo, binDir} = setupCapMission("cap-s3", "cap_always", {per_task_max_turns: 5, continuation_allowance: 1});
  try {
    const run = runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s3: two generations ran (no wrap-up turns), then escalation (no third generation)",
      generations.length === 2 && wrapups.length === 0, impls.length);
    check("s3: both capped generations carry the wrap-up flag and the orchestrator fallback",
      generations.every((g) => g.data?.capped?.wrapUp === true && g.data?.wrapUp?.status === "orchestrator_fallback"
      && g.data?.wrapUp?.fallbackNote === true),
      generations.map((g) => g.data?.wrapUp));
    const state = readState(repo);
    check("s3: mission escalated as task-not-converging",
      state.phase === "escalated" && state.step === "standalone_task_not_converging",
      {phase: state.phase, step: state.step});
    check("s3: ap did not exit 0", run.status !== 0, run.status);
    check("s3: escalation names the cap",
      `${run.stdout}\n${run.stderr}`.includes("did not converge"), (run.stderr || "").slice(-300));
    // Backlog #27: the escalation ends with the exact resume command; the
    // note is kept as post-mortem (like dead-ends) and the key is recorded.
    check("s3: escalation ends with the exact resume command",
      `${run.stdout}\n${run.stderr}`.includes("Resume: ap reset --scope task:standalone:phase-0:") 
      && `${run.stdout}\n${run.stderr}`.includes("then ap run"), (run.stderr || "").slice(-300));
    const s3NotePath = (/Keep a hand-off note at (\S+)/.exec(briefText(repo, generations[0]) || "") || [])[1]?.replace(/[.,;:]+$/, "");
    check("s3: hand-off note kept on escalation (post-mortem)",
      s3NotePath ? fs.existsSync(path.join(repo, s3NotePath)) : false, s3NotePath);
    check("s3: escalation recorded the continuation for bare `ap reset`",
      (readState(repo).lastContinuation?.scope || "").startsWith("task:standalone:phase-0:"), readState(repo).lastContinuation);
    const key = continuationKey(state);
    check("s3: continuation ledger shows used=2 over limit=1",
      key !== undefined && state.continuationBudgets[key] === 2, state.continuationBudgets);
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── S7 (backlog #32): no-progress stop beats a large allowance ──
// Always-spin with NO file edits and allowance 5: after 2 consecutive
// no-edit generations the task stops as no-progress, long before the
// allowance (which would have allowed 6 generations) runs out.
{
  const {repo, binDir} = setupCapMission("cap-s7", "cap_always", {per_task_max_turns: 5, continuation_allowance: 5});
  try {
    const run = runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s7: exactly two no-edit generations ran (no wrap-up turns), not six",
      generations.length === 2 && wrapups.length === 0, {generations: generations.length, wrapups: wrapups.length});
    check("s7: both capped generations recorded the orchestrator fallback (never a resumed session)",
      generations.every((g) => g.data?.capped?.wrapUp === true
      && g.data?.wrapUp?.status === "orchestrator_fallback"
      && g.data?.wrapUp?.reason === "note_missing_or_stale"
      && g.data?.wrapUp?.fallbackNote === true),
      generations.map((g) => g.data?.wrapUp));
    const state = readState(repo);
    check("s7: mission escalated as task-no-progress",
      state.phase === "escalated" && state.step === "standalone_task_no_progress", {phase: state.phase, step: state.step});
    check("s7: escalation evidence names the consecutive count and limit",
      state.phaseCheckpointError?.code === "NO_PROGRESS"
      && state.phaseCheckpointError?.evidence?.consecutive === 2 && state.phaseCheckpointError?.evidence?.limit === 2,
      state.phaseCheckpointError);
    check("s7: message says no file changed and ends with the resume command",
      `${run.stdout}\n${run.stderr}`.includes("changed no file in 2 consecutive sessions")
      && `${run.stdout}\n${run.stderr}`.includes("Resume: ap reset --scope task:standalone:phase-0:"), (run.stderr || "").slice(-400));
    check("s7: continuation recorded for bare `ap reset`",
      (state.lastContinuation?.scope || "").startsWith("task:standalone:phase-0:"), state.lastContinuation);
    check("s7: ap did not exit 0", run.status !== 0, run.status);
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── S4: voluntary early stop continues (never commits), then exhausts ──
// Generation 1 spins into the turn cap (dead end names its tree files);
// generation 2 stops voluntarily with a well-formed "attempted" sentinel
// (dead end carries its summary). Neither commits nor reviews: with
// allowance 1 the second generation exhausts into task_not_converging.
{
  const {repo, binDir} = setupCapMission("cap-s4", "cap_files_spin", {per_task_max_turns: 5, continuation_allowance: 1});
  try {
    const run = runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s4: two generations ran (no wrap-up turns), then escalation (no third generation)",
      generations.length === 2 && wrapups.length === 0, impls.length);
    check("s4: generation 1 capped on turns, fallback note recorded (never a resumed session)",
      generations[0]?.data?.capped?.type === "turns" && generations[0]?.data?.wrapUp?.status === "orchestrator_fallback"
      && generations[0]?.data?.wrapUp?.fallbackNote === true,
      generations[0]?.data?.capped);
    const state = readState(repo);
    check("s4: mission escalated as task-not-converging",
      state.phase === "escalated" && state.step === "standalone_task_not_converging",
      {phase: state.phase, step: state.step});
    check("s4: ap did not exit 0", run.status !== 0, run.status);
    const key = continuationKey(state);
    check("s4: continuation consumed twice (breach + early stop)",
      key !== undefined && state.continuationBudgets[key] === 2, state.continuationBudgets);
    const dead = (state.rolloverDeadEnds || {})[key] || [];
    check("s4: first dead end names the generation's tree files",
      dead.length === 2 && dead[0].reason === "turns" && dead[0].tail.includes("cap-e2e-probe-01.txt"), dead);
    check("s4: second dead end carries the voluntary-stop summary",
      dead[1].reason === "incomplete" && dead[1].tail.includes("remaining"), dead[1]);
    check("s4: no reviewer ever launched (partial work never reaches review)",
      readObservedEvents(repo).every((e) => e.role !== "code_reviewer" && e.role !== "verifier"));
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── S5: missing-note fallback — the agent never wrote a note ──
// Generation 1 spins into the turn cap (like S1) but models the mission-022
// agent: it never wrote a note at all (`cap_wrapup_silent`). Mission 045:
// the session is not resumed; the orchestrator builds the fallback note
// from the session-only changes + session digest, writes it at the hand-off path,
// and records orchestrator_fallback. The rollover still starts gen-2 — now
// with the fallback note above the digest — and completes.
{
  const {repo, binDir} = setupCapMission("cap-s5", "cap_wrapup_silent", {per_task_max_turns: 5});
  try {
    runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s5: breach produced gen-1, then gen-2 — no wrap-up run (two implementer runs)",
      impls.length === 2 && generations.length === 2 && wrapups.length === 0, impls.length);
    const gen1 = generations[0]?.data;
    check("s5: generation 1 capped with the wrap-up flag",
      gen1?.capped?.wrapUp === true, gen1?.capped);
    check("s5: fallback recorded (orchestrator wrote the missing note), never retried",
      gen1?.wrapUp?.status === "orchestrator_fallback" && gen1?.wrapUp?.reason === "note_missing_or_stale"
      && gen1?.wrapUp?.fallbackNote === true, gen1?.wrapUp);
    const gen1NotePath = (/Keep a hand-off note at (\S+)/.exec(briefText(repo, generations[0]) || "") || [])[1]?.replace(/[.,;:]+$/, "");
    const gen2Brief = briefText(repo, generations[1]) || "";
    const gen2Note = noteSectionOf(gen2Brief);
    check("s5: gen-1 brief named its hand-off note path", typeof gen1NotePath === "string" && gen1NotePath.endsWith(".md"), gen1NotePath);
    check("s5: orchestrator fallback note written at the hand-off path",
      gen2Note.includes("(orchestrator fallback)"), gen2Note.slice(0, 200));
    check("s5: the fallback note is the orchestrator's (diff + digest, no agent marker)",
      gen2Note.includes("## Session work digest")
      && !gen2Note.includes("GEN1-HANDOFF-MARKER"), gen2Note.slice(0, 200));
    check("s5: gen-2 brief renders the fallback note above the digest",
      gen2Brief.includes("## Hand-off note from the previous session")
      && gen2Brief.includes("orchestrator fallback")
      && gen2Brief.includes("Dead ends from capped generations")
      && gen2Brief.indexOf("## Hand-off note from the previous session") < gen2Brief.indexOf("## Dead ends from capped generations"),
      gen2Brief.slice(0, 300));
    check("s5: generation 2 completed", generations[1]?.data?.status === "completed", generations[1]?.data?.status);
    check("s5: continuation ledger clean after task success (fallback never consumed extra)",
      continuationKey(readState(repo)) === undefined);
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── S6: no-session fallback — nothing to resume, fallback still written ──
// `cap_nosid` emits no session id at all. Mission 045 removed the resume
// path entirely, so the missing session id no longer selects a skip: the
// orchestrator fallback fires the same way (the agent's own note was
// backdated/stale), and — backlog #15 part 2 — the fallback KEEPS that
// stale model note below it under the "Previous note (written by the
// model)" heading. Gen-2 renders the merged note above the digest, and
// completes. No wrap-up run exists.
{
  const {repo, binDir} = setupCapMission("cap-s6", "cap_nosid", {per_task_max_turns: 5});
  try {
    runAutopilot(repo, binDir, {request: "cap probe", timeoutMs: AP_TIMEOUT_MS});
    const impls = implementerRuns(repo);
    const {wrapups, generations} = splitGenerations(repo, impls);
    check("s6: no wrap-up run to make (two generations only)",
      impls.length === 2 && generations.length === 2 && wrapups.length === 0, impls.length);
    const gen1 = generations[0]?.data;
    check("s6: generation 1 capped with the wrap-up flag but no session recorded",
      gen1?.capped?.wrapUp === true && (gen1?.sessionId === null || gen1?.sessionId === undefined), gen1?.capped);
    check("s6: orchestrator fallback recorded, mission continues",
      gen1?.wrapUp?.status === "orchestrator_fallback" && gen1?.wrapUp?.reason === "note_missing_or_stale"
      && gen1?.wrapUp?.fallbackNote === true, gen1?.wrapUp);
    const gen1NotePath = (/Keep a hand-off note at (\S+)/.exec(briefText(repo, generations[0]) || "") || [])[1]?.replace(/[.,;:]+$/, "");
    const gen2Brief = briefText(repo, generations[1]) || "";
    const gen2Note = noteSectionOf(gen2Brief);
    check("s6: gen-1 brief named its hand-off note path", typeof gen1NotePath === "string" && gen1NotePath.endsWith(".md"), gen1NotePath);
    check("s6: fallback note written at the hand-off path",
      gen2Note.includes("(orchestrator fallback)"), gen2Note.slice(0, 200));
    check("s6: gen-2 brief renders the orchestrator fallback above the digest (the stale agent note is kept)",
      gen2Brief.includes("## Hand-off note from the previous session")
      && gen2Brief.includes("orchestrator fallback")
      && gen2Brief.includes("## Previous note (written by the model)")
      && gen2Brief.includes("GEN1-HANDOFF-MARKER"), gen2Brief.slice(0, 400));
    check("s6: generation 2 completed", generations[1]?.data?.status === "completed", generations[1]?.data?.status);
  } finally { if (!process.env.KEEP_CAP_FIXTURE) cleanup(repo, binDir); }
}

// ── Mission 039 task 2.1: per-role wrap-up threshold (pure, no subprocess) ──
// Mirrors runRelay()'s wrapupTokens resolution in scripts/autopilot.mjs:
// review roles in PER_ROLE_WRAPUP_TOKENS_DEFAULT use
// roleCaps.wrapUpTokenThreshold; implementer/unknown roles keep the global
// policy.handoff_wrapup_tokens via resolveHandoffWrapupTokens.
function relayWrapupTokens(roleName, policy) {
  const roleCaps = resolvePerRoleLimits(roleName, policy);
  return Object.hasOwn(PER_ROLE_WRAPUP_TOKENS_DEFAULT, String(roleName ?? "").toLowerCase())
    ? roleCaps.wrapUpTokenThreshold
    : resolveHandoffWrapupTokens(policy, roleCaps.perTaskMaxTokens);
}
{
  const reviewerCaps = resolvePerRoleLimits("code_reviewer", {});
  const reviewerTokens = relayWrapupTokens("code_reviewer", {});
  const reviewerUsage = {turns: 1, maxSingleTurnContext: 140_000}; // per-turn 140K
  const reviewerTrigger = checkWrapupTrigger({usage: reviewerUsage, perTaskMaxTurns: reviewerCaps.perTaskMaxTurns, perTaskMaxTokens: reviewerCaps.perTaskMaxTokens, wrapupTokens: reviewerTokens});
  const reviewerGlobal = checkWrapupTrigger({usage: reviewerUsage, perTaskMaxTurns: reviewerCaps.perTaskMaxTurns, perTaskMaxTokens: reviewerCaps.perTaskMaxTokens, wrapupTokens: resolveHandoffWrapupTokens({}, reviewerCaps.perTaskMaxTokens)});
  check("per-role wrapup: review role uses own threshold",
    reviewerTokens === 135_000 && reviewerTrigger?.type === "tokens" && reviewerTrigger?.limit === 135_000 && reviewerGlobal === null,
    {reviewerTokens, reviewerTrigger, reviewerGlobal});
  const plannerCaps = resolvePerRoleLimits("planner", {});
  const plannerTokens = relayWrapupTokens("planner", {});
  const plannerUsage = {turns: 1, maxSingleTurnContext: 170_000}; // per-turn 170K
  const plannerTrigger = checkWrapupTrigger({usage: plannerUsage, perTaskMaxTurns: plannerCaps.perTaskMaxTurns, perTaskMaxTokens: plannerCaps.perTaskMaxTokens, wrapupTokens: plannerTokens});
  const plannerGlobal = checkWrapupTrigger({usage: plannerUsage, perTaskMaxTurns: plannerCaps.perTaskMaxTurns, perTaskMaxTokens: plannerCaps.perTaskMaxTokens, wrapupTokens: resolveHandoffWrapupTokens({}, plannerCaps.perTaskMaxTokens)});
  check("per-role wrapup: planner waits for its own threshold",
    plannerTokens === 180_000 && plannerTrigger === null && plannerGlobal?.type === "tokens",
    {plannerTokens, plannerTrigger, plannerGlobal});
  const implPolicy = {handoff_wrapup_tokens: 150_000};
  const implCaps = resolvePerRoleLimits("implementer", implPolicy);
  const implTokens = relayWrapupTokens("implementer", implPolicy);
  const implUsage = {turns: 1, maxSingleTurnContext: 155_000}; // per-turn 155K
  const implTrigger = checkWrapupTrigger({usage: implUsage, perTaskMaxTurns: implCaps.perTaskMaxTurns, perTaskMaxTokens: implCaps.perTaskMaxTokens, wrapupTokens: implTokens});
  check("per-role wrapup: implementer uses global handoff_wrapup_tokens",
    implTokens === 150_000 && implTrigger?.type === "tokens" && implTrigger?.limit === 150_000,
    {implTokens, implTrigger});
}

console.log(`\ncap-breach rollover e2e done, ${failures} failure(s)`);
if (failures) process.exit(1);
