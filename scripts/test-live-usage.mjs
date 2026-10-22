#!/usr/bin/env node
// TASK-27 (backlog 003#8 remainder) — live per-invocation totals.
//
// Unit (every platform): updateRunUsage() cadence in run-observability.mjs
// (persist on +2 turns, no write under threshold, 10s floor honored, null /
// non-object / turn-less usage writes nothing, per-dir memory, finalizeRun
// clears the memory) and the watch PRICE/TURNS cells in run-history.mjs (~
// only with status:"running"; finalized rows unchanged; TURNS unprefixed).
//
// Integration (needs a hermetic opencode binary — same SKIP contract as
// test-cap-breach-rollover.mjs): a real `node scripts/autopilot.mjs run`
// mission whose implementer streams opencode step_finish events in two
// waves (3 turns, 12s sleep, 3 more — the new `live_usage` scenario in
// fake-cap-breach-adapter.mjs) proves status.json gains usage mid-run, the
// watch PRICE shows ~… for the running run, and plain totals after
// finalize. A driverless (cursor) mission proves - throughout with no
// fabricated usage. Only implementer relays ever launch, so no platform
// SKIP is needed for the mission shape itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn, spawnSync} from "node:child_process";
import {initRun, finalizeRun, updateRunUsage} from "./run-observability.mjs";
import {resolvePerRoleLimits, checkCapBreach, checkWrapupTrigger, PER_ROLE_CAPS_DEFAULT, PER_ROLE_WRAPUP_TOKENS_DEFAULT} from "./per-task-budget.mjs";
import {buildReviewWrapUpPrompt} from "./standalone-handoff.mjs";
import {priceCellText, contextCellText, turnsCellText, readRunMeta, renderCurrentDetail} from "./run-history.mjs";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, cleanup, withoutOuterGitGuard,
} from "./test-fixtures/workflow-order-harness.mjs";

// Nested missions install their own git guard; strip any outer mission/gate
// guard (PATH shim + hooks) so every git call does not pass through both
// (~4x slower under the orchestrator gate).
const missionEnv = (binDir) => {
  const base = withoutOuterGitGuard({...process.env});
  const sep = process.platform === "win32" ? ";" : ":";
  return {...base, PATH: `${binDir}${sep}${base.PATH || ""}`};
};
import {resolveAgentBinary} from "./agent-process.mjs";
import {accumulateUsage} from "./adapter-drivers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const LIVE_FIXTURE = path.join(here, "test-fixtures", "fake-cap-breach-adapter.mjs");
const REVIEW_FIXTURE = path.join(here, "test-fixtures", "fake-opencode-review-adapter.sh");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Unit: updateRunUsage cadence ─────────────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-live-usage-"));
  const dir = path.join(root, "run-1");
  initRun(dir, {role: "implementer"});
  const usageAt = (turns) => ({input: 10 * turns, cacheCreation: 0, cacheRead: 0, output: 5 * turns, turns, priceWeighted: 35 * turns});
  const readUsage = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).usage ?? null;
  const updatedAt = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).updated_at;

  check("persist: first write is immediate", updateRunUsage(dir, usageAt(2)) === true);
  check("persist: status.json carries the totals", readUsage()?.turns === 2, readUsage());
  const stamp = updatedAt();
  check("persist: no write under the +2 threshold", updateRunUsage(dir, usageAt(3)) === false && updatedAt() === stamp);
  check("persist: +2 turns still blocked by the 10s floor", updateRunUsage(dir, usageAt(4)) === false && updatedAt() === stamp);
  check("persist: floor bypassed by option writes", updateRunUsage(dir, usageAt(4), {minIntervalMs: 0}) === true && readUsage()?.turns === 4);
  await sleep(10500);
  check("persist: +2 turns after the floor writes", updateRunUsage(dir, usageAt(6)) === true && readUsage()?.turns === 6);
  const frozen = fs.readFileSync(path.join(dir, "status.json"), "utf8");
  check("persist: null usage writes nothing, ever",
    updateRunUsage(dir, null) === false && fs.readFileSync(path.join(dir, "status.json"), "utf8") === frozen);
  for (const bad of ["x", 42, ["turns"], {input: 1}]) {
    check(`persist: non-object/turn-less usage writes nothing (${JSON.stringify(bad)})`,
      updateRunUsage(dir, bad) === false && fs.readFileSync(path.join(dir, "status.json"), "utf8") === frozen);
  }
  // Memory is per dir: a second dir persists immediately at the same turns.
  const dir2 = path.join(root, "run-2");
  initRun(dir2, {role: "implementer"});
  check("persist: memory is per run dir", updateRunUsage(dir2, usageAt(2)) === true);
  // finalizeRun clears the memory: the same totals persist immediately again.
  finalizeRun(dir, {status: "completed", exitCode: 0, decision: "PASS", startedAt: null});
  check("persist: finalize clears the cadence memory", updateRunUsage(dir, usageAt(2)) === true);
  fs.rmSync(root, {recursive: true, force: true});
}

// ── Unit: watch cells ────────────────────────────────────────────────────
check("cells: running run prefixes the live price",
  priceCellText({status: "running", usage: {priceWeighted: 12600}}) === "~12.6K");
check("cells: finalized row keeps the plain price",
  priceCellText({status: "completed", usage: {priceWeighted: 12600}}) === "12.6K");
check("cells: status-less fixture keeps the plain price (existing pins unaffected)",
  priceCellText({usage: {priceWeighted: 64935.3}}) === "64.9K");
check("cells: running run without usage still renders -",
  priceCellText({status: "running", usage: null}) === "-" && priceCellText({status: "running"}) === "-");
check("cells: TURNS stays unprefixed while running",
  turnsCellText({status: "running", usage: {turns: 8}}) === "8");

// ── Unit: Claude maxSingleTurnContext with a terminal result event ───────
// Per-message footprints (50K, 35K); the terminal result carries the
// cumulative total (85K). maxSingleTurnContext must be the per-message max,
// never the cumulative total.
{
  const assistant = (id, usage) => ({type: "assistant", message: {id, role: "assistant", content: [{type: "text"}], usage}});
  const msgUsage = {input_tokens: 40000, output_tokens: 10, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0};
  const resultEvents = [
    assistant("msg_1", msgUsage, "thinking"),
    assistant("msg_1", msgUsage, "tool_use"),
    assistant("msg_2", {input_tokens: 5000, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000}),
    {type: "result", subtype: "success", is_error: false, result: "done", num_turns: 2,
      usage: {input_tokens: 45000, output_tokens: 900, cache_creation_input_tokens: 10000, cache_read_input_tokens: 30000}},
  ];
  const resultUsage = accumulateUsage("claude", resultEvents);
  check("usage: Claude case with result event gives per-message max (50K), not the cumulative total (85K)",
    resultUsage?.turns === 2 && resultUsage?.maxSingleTurnContext === 50000, resultUsage);
}

// ── Static: role split inside runRelay's monitor ─────────────────────────
// Live totals decode for every role with a usage-capable driver, while cap
// enforcement (kill + result.capped) stays implementer-only. Pinned by
// order: usage persist → implementer gate → breach check.
{
  const autopilotSource = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");
  // Ungated declaration: `const usageDriver=adapterDriver(role.adapter<, extra args>)` with no ternary/gate.
  const usageDriverAt = autopilotSource.search(/const usageDriver=adapterDriver\(role\.adapter[,)]/);
  const persistAt = autopilotSource.indexOf("if(updateRunUsage(dir,usage))");
  const gateAt = autopilotSource.indexOf("if(!capDriver) return;");
  const breachAt = autopilotSource.indexOf("const breach=checkCapBreach({usage,");
  check("wiring: live totals use an un-gated usageDriver",
    usageDriverAt !== -1
    && /usageDriver\.decodeEvents\(capStdout,capStderr[,)]/.test(autopilotSource)
    && /accumulateUsage\(role\.adapter,capEvents[,)]/.test(autopilotSource),
    {usageDriverAt});
  check("wiring: persist precedes the implementer-only cap gate precedes the wrap-up/cap checks",
    persistAt !== -1 && gateAt !== -1 && breachAt !== -1 && persistAt < gateAt && gateAt < breachAt,
    {persistAt, gateAt, breachAt});
  check("wiring: capDriver itself stays implementer-only (wrap-up turn exempt with its own ceiling)",
    autopilotSource.includes('const capDriver=(!isWrapUp && capEnabled)?adapterDriver(role.adapter):null'));
  check("wiring: wrap-up trigger evaluated before the hard cap (fixed tokens, raw growing term)",
    autopilotSource.includes("checkWrapupTrigger({usage,perTaskMaxTurns:roleCaps.perTaskMaxTurns,perTaskMaxTokens:roleCaps.perTaskMaxTokens,wrapupTokens})"));
  check("cells: CONTEXT shows the raw growing term next to PRICE (~ while running)",
    contextCellText({status: "running", usage: {input: 1000, cacheRead: 500000}}) === "~501.0K"
    && contextCellText({usage: {input: 1000, cacheRead: 500000}}) === "501.0K"
    && contextCellText({usage: null}) === "-");
  // 031 T8.3: CAP_BREACH + WRAP_UP observe lines and the watch report label
  // the per-turn context explicitly as RAW_TOKENS (raw maxSingleTurnContext).
  check("wiring: CAP_BREACH observe line shows RAW_TOKENS labelled raw",
    autopilotSource.includes("CAP_BREACH") && autopilotSource.includes("RAW_TOKENS=${")
    && autopilotSource.includes("(raw maxSingleTurnContext)"));
  check("wiring: WRAP_UP observe line shows RAW_TOKENS labelled raw",
    autopilotSource.includes("WRAP_UP | STATUS=") && autopilotSource.includes("RAW_TOKENS=${")
    && autopilotSource.includes("(raw maxSingleTurnContext)"));
  {
    const runHistorySource = fs.readFileSync(path.join(skillRoot, "scripts", "run-history.mjs"), "utf8");
    check("wiring: watch report generator emits the RAW_TOKENS raw label",
      runHistorySource.includes("RAW_TOKENS=") && runHistorySource.includes("(raw maxSingleTurnContext)"));
    const detail = renderCurrentDetail({dirName: "01-implementer-x", id: "x", status: "completed", usage: {input: 1000, cacheRead: 500000}, exit_code: 0}, []);
    check("wiring: CURRENT RUN detail carries RAW_TOKENS labelled raw",
      detail.includes("RAW_TOKENS=501000 (raw maxSingleTurnContext)"));
  }
}

// ── Static: per-role cap breach (031 Phase 10.1) ─────────────────────────
// Every review/planning role enforces the same 22-turn per-turn-context cap
// with a wrap-up threshold: breach kills + continuation, wrap-up takes the
// hand-off note away from the capped session (mission 045) and the
// orchestrator writes it itself from this session's own changed paths.
// Pure-function pins (run everywhere) + wiring pins on autopilot.mjs.
{
  const ROLES_031 = ["code_reviewer", "verifier", "planner", "plan_reviewer"];
  for (const role of ROLES_031) {
    const limits = resolvePerRoleLimits(role, {});
    const expTokens = role === "planner" ? 200000 : 150000;
    const expWrapup = role === "planner" ? 180000 : 135000;
    const expTurns = (role === "verifier" || role === "planner" || role === "plan_reviewer") ? 30 : 22; // backlog #59(b), #111 (plan_reviewer 30)
    check(`caps/${role}: defaults are ${expTurns} turns / ${expTokens} tokens / allowance 2`,
      limits.perTaskMaxTurns === expTurns && limits.perTaskMaxTokens === expTokens && limits.continuationAllowance === 2,
      limits);
    check(`caps/${role}: wrap-up threshold ${expWrapup} sits below the ${expTokens} cap`,
      limits.wrapUpTokenThreshold === expWrapup && limits.wrapUpTokenThreshold < limits.perTaskMaxTokens,
      limits);
    check(`caps/${role}: PER_ROLE_CAPS_DEFAULT matches resolved limits`,
      PER_ROLE_CAPS_DEFAULT[role]?.maxTurns === expTurns && PER_ROLE_CAPS_DEFAULT[role]?.maxTokens === expTokens
      && PER_ROLE_CAPS_DEFAULT[role]?.extraSessions === 2 && PER_ROLE_WRAPUP_TOKENS_DEFAULT[role] === expWrapup);
    const atTurnCap = {turns: expTurns, input: 10, cacheRead: 10};
    const overTurnCap = {turns: expTurns + 1, input: 10, cacheRead: 10};
    check(`caps/${role}: ${expTurns} turns is not a breach (cap is exclusive)`,
      checkCapBreach({usage: atTurnCap, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens}) === null);
    const turnBreach = checkCapBreach({usage: overTurnCap, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens});
    check(`caps/${role}: ${expTurns + 1} turns breaches (continuation triggers)`,
      turnBreach !== null && turnBreach.type === "turns" && turnBreach.limit === expTurns, turnBreach);
    const cap = limits.perTaskMaxTokens;
    const wrap = limits.wrapUpTokenThreshold;
    const atTokenCap = {turns: 1, input: cap / 2, cacheRead: cap / 2};
    const overTokenCap = {turns: 1, input: cap / 2 + 1, cacheRead: cap / 2};
    check(`caps/${role}: ${cap} raw tokens is not a breach`,
      checkCapBreach({usage: atTokenCap, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens}) === null);
    const tokenBreach = checkCapBreach({usage: overTokenCap, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens});
    check(`caps/${role}: ${cap + 1} raw tokens breaches (continuation triggers)`,
      tokenBreach !== null && tokenBreach.type === "tokens" && tokenBreach.limit === cap, tokenBreach);
    const belowWrapup = {turns: 1, input: wrap / 2 - 1, cacheRead: wrap / 2};
    const atWrapup = {turns: 1, input: wrap / 2, cacheRead: wrap / 2};
    check(`caps/${role}: below ${wrap} raw no wrap-up trigger`,
      checkWrapupTrigger({usage: belowWrapup, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens, wrapupTokens: limits.wrapUpTokenThreshold}) === null);
    const wrapTrigger = checkWrapupTrigger({usage: atWrapup, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens, wrapupTokens: limits.wrapUpTokenThreshold});
    check(`caps/${role}: ${wrap} raw fires the wrap-up trigger before the hard cap`,
      wrapTrigger !== null && wrapTrigger.type === "tokens", wrapTrigger);
    const wrapTurn = checkWrapupTrigger({usage: overTurnCap, perTaskMaxTurns: limits.perTaskMaxTurns, perTaskMaxTokens: limits.perTaskMaxTokens, wrapupTokens: limits.wrapUpTokenThreshold});
    check(`caps/${role}: turn-cap breach itself is a wrap-up trigger (cap-exempt note turn still has room)`,
      wrapTurn !== null && wrapTurn.type === "turns", wrapTurn);
    const prompt = buildReviewWrapUpPrompt(role, {taskRef: `task:standalone:phase-0:${role}`, notePath: `.autopilot/missions/M/handoff/T.md`});
    check(`caps/${role}: wrap-up template still carries Found + Next sections`,
      typeof prompt === "string" && prompt.includes("## Found") && prompt.includes("## Next") && prompt.includes(role),
      prompt.slice(0, 80));
  }
  const autopilotSrc = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");
  for (const role of ["code_reviewer", "verifier"]) {
    check(`caps/${role}: capped branch consumes a continuation with the role allowance`,
      autopilotSrc.includes(`resolvePerRoleLimits('${role}',c.policy).continuationAllowance`)
      && new RegExp(`consumeContinuation\\(s,c\\.policy,contScope,resolvePerRoleLimits\\('${role}',c\\.policy\\)\\.continuationAllowance\\)`).test(autopilotSrc));
  }
  for (const [role, trigger] of [["planner", "capped"], ["planner", "incomplete"], ["plan_reviewer", "capped"], ["plan_reviewer", "incomplete"]]) {
    check(`caps/${role}: planning ${trigger} path routes through handlePlanningContinuation`,
      autopilotSrc.includes(`handlePlanningContinuation(s,'${role}'`) && autopilotSrc.includes(`,'${trigger}')`));
  }
  // Mission 045: a capped session that could not write its own note is never
  // resumed — the orchestrator writes the fallback note from this session's
  // own changed paths (shared changed-files stat limited to those paths) plus the session work
  // digest and records it on the run record.
  check("caps/wrap-up: breach writes the orchestrator fallback note (no wrap-up resume)",
    autopilotSrc.includes("buildOrchestratorFallbackNote(taskRef,events,role.adapter,repo,diffStat,capBreach,sessionPaths)")
    && /changedFilesStat\(cwd,\{paths:sessionPaths\}\)/.test(autopilotSrc)
    && /fs\.writeFileSync\(path\.join\(repo,noteRel\),fallbackNote\)/.test(autopilotSrc)
    && autopilotSrc.includes('{status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach.trigger||null,note:noteRel,fallbackNote:true}')
    && autopilotSrc.includes("fallbackNote:true")
    && !autopilotSrc.includes('runNote:"wrap-up"')
    && !autopilotSrc.includes('reason:"no_session_id"'));
}

// ── Integration: hermetic-binary gate (SKIP, never silent) ───────────────
let opencodeHermetic = false;
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-live-probe-"));
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
    opencodeHermetic = typeof resolved === "string"
      && path.resolve(resolved).toLowerCase().startsWith(path.resolve(probeDir).toLowerCase());
  } finally {
    try { fs.rmSync(probeDir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

function setupLiveMission(prefix, scenario, {adapter = "opencode", reviewerAdapter = null, reviewerShim = null, policyExtra = {}} = {}) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  // The reviewer's `opencode` binary: either the shared Node fixture
  // (works wherever Node runs) or a POSIX-only .sh fixture (the only thing
  // that can exec inside the bubblewrap envelope — no Node runtime is
  // reachable there; see fake-opencode-review-adapter.sh's header).
  if (reviewerShim) {
    const target = path.join(binDir, "opencode");
    fs.copyFileSync(reviewerShim, target);
    fs.chmodSync(target, 0o755);
  } else if (adapter === "opencode" || reviewerAdapter === "opencode") {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(binDir, "opencode.cmd"),
        `@echo off\r\n"${process.execPath}" "${LIVE_FIXTURE}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const shim = path.join(binDir, "opencode");
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${LIVE_FIXTURE}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
    }
  }
  writeConfig(repo, {planningFramework: "standalone"});
  const configFile = path.join(repo, ".autopilot", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (adapter === "opencode") config.roles.implementer.adapter = "opencode";
  if (reviewerAdapter) config.roles.code_reviewer.adapter = reviewerAdapter;
  config.policy = {per_task_timeout_ms: 60000, per_task_max_turns: 1000, per_task_max_tokens: 100000000, ...policyExtra};
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  setScenario(repo, scenario);
  const mission = "001-live-usage";
  fs.mkdirSync(path.join(repo, ".autopilot", "missions", mission), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "missions", mission, "PLAN.md"), "# Plan\n\nObjective: live usage probe.\n");
  fs.writeFileSync(path.join(repo, ".autopilot", "missions", mission, "TASKS.md"), "## Phase 1: General\n\n- [ ] Do the fixture task\n");
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission, planningRequest: "live usage probe",
  }, null, 2));
  return {repo, binDir, mission};
}

// Every status.json whose run recorded the given role, in readdir order.
function roleRunDirs(repo, mission, role) {
  const roots = [
    path.join(repo, ".autopilot", "runs"),
    path.join(repo, ".autopilot", "missions", mission, "runs"),
  ];
  const found = [];
  for (const runsDir of roots) {
    let entries = [];
    try { entries = fs.readdirSync(runsDir, {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statusFile = path.join(runsDir, entry.name, "status.json");
      try {
        const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (status?.role === role) found.push({dir: path.join(runsDir, entry.name), status});
      } catch { /* not yet written — keep polling */ }
    }
  }
  return found;
}

// Every status.json whose run recorded the implementer role, oldest first.
function implementerRunDirs(repo) {
  return roleRunDirs(repo, "001-live-usage", "implementer");
}

function watchFile(repo, mission) {
  const missionWatch = path.join(repo, ".autopilot", "missions", mission, "WATCH-REPORT.md");
  if (fs.existsSync(missionWatch)) return missionWatch;
  return path.join(repo, ".autopilot", "WATCH-REPORT.md");
}

function roleWatchLine(repo, mission, role) {
  let text = "";
  try { text = fs.readFileSync(watchFile(repo, mission), "utf8"); } catch { return null; }
  // A run row, never a group header ("Attempt 1 — 1 run [implementer → …]"
  // also mentions the role): run rows carry a normalized status token.
  const line = text.split(/\r?\n/).find((l) => l.includes(role)
    && /\b(RUNNING|COMPLETED|APPROVED|DENIED|INCOMPLETE|PASS|FAIL|FAILED|CAPPED|KILLED|INTERRUPTED|UNKNOWN)\b/.test(l));
  return line ?? null;
}

function implementerWatchLine(repo, mission) {
  return roleWatchLine(repo, mission, "implementer");
}

function spawnAutopilot(repo, binDir, request, timeoutMs = 150000) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const child = spawn(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", request, "--repo", repo], {
    cwd: repo, shell: false, stdio: "ignore",
    env: missionEnv(binDir),
  });
  const waitExit = new Promise((resolve) => {
    const watchdog = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({timedOut: true}); }, timeoutMs);
    child.on("exit", (code, signal) => { clearTimeout(watchdog); resolve({timedOut: false, code, signal}); });
    child.on("error", (error) => { clearTimeout(watchdog); resolve({timedOut: false, error: String(error)}); });
  });
  return {child, waitExit};
}

// ── Integration C1: usage signal streams live, then finalizes ────────────
if (!opencodeHermetic) {
  skips("live/signal", `a real opencode binary outscores the fixture shim on this machine; live-usage e2e needs hermetic binary resolution.`);
} else {
  const {repo, binDir, mission} = setupLiveMission("live-signal", "live_usage");
  try {
    const delimiter = process.platform === "win32" ? ";" : ":";
    const child = spawn(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "live usage probe", "--repo", repo], {
      cwd: repo, shell: false, stdio: "ignore",
      env: missionEnv(binDir),
    });
    const waitExit = new Promise((resolve) => {
      const watchdog = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({timedOut: true}); }, 150000);
      child.on("exit", (code, signal) => { clearTimeout(watchdog); resolve({timedOut: false, code, signal}); });
      child.on("error", (error) => { clearTimeout(watchdog); resolve({timedOut: false, error: String(error)}); });
    });
    // Mid-run: the first wave (3 turns) persists on the first 1s tick, while
    // the 12s inter-wave sleep holds the run open for observation.
    let midUsage = null;
    for (let i = 0; i < 100 && !midUsage; i += 1) {
      await sleep(250);
      const hit = implementerRunDirs(repo).find((r) => Number(r.status?.usage?.turns) === 3);
      if (hit) midUsage = hit.status.usage;
    }
    check("live/signal: status.json gains usage mid-run (first wave persists)",
      midUsage !== null && midUsage.turns === 3, midUsage);
    // Backlog #214: the watch file is a periodically rewritten snapshot and
    // can lag status.json under a loaded gate. Wait for the running row's
    // live `~` (the 12s inter-wave sleep holds the run open) instead of
    // reading it once after a fixed delay.
    let midLine = implementerWatchLine(repo, mission);
    for (let i = 0; i < 24 && !(midLine && midLine.includes("~")); i += 1) {
      await sleep(250);
      midLine = implementerWatchLine(repo, mission);
    }
    check("live/signal: watch PRICE shows ~… for the running run",
      midLine !== null && midLine.includes("~"), midLine);
    const exit = await waitExit;
    check("live/signal: mission process exited (no hang)", exit.timedOut !== true, exit);
    const final = implementerRunDirs(repo)[0];
    check("live/signal: finalized totals cover both waves",
      final?.status?.usage?.turns === 6 && final?.status?.usage?.priceWeighted === 210,
      final?.status?.usage);
    const finalLine = implementerWatchLine(repo, mission);
    check("live/signal: watch shows plain totals after finalize (no ~)",
      finalLine !== null && finalLine.includes("210") && !finalLine.includes("~"), finalLine);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Integration C2: driverless stream stays -, no fabrication ────────────
{
  const {repo, binDir, mission} = setupLiveMission("live-driverless", "success", {adapter: "cursor"});
  try {
    const delimiter = process.platform === "win32" ? ";" : ":";
    const child = spawn(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "live usage probe", "--repo", repo], {
      cwd: repo, shell: false, stdio: "ignore",
      env: missionEnv(binDir),
    });
    const exit = await new Promise((resolve) => {
      const watchdog = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({timedOut: true}); }, 150000);
      child.on("exit", (code, signal) => { clearTimeout(watchdog); resolve({timedOut: false, code, signal}); });
      child.on("error", (error) => { clearTimeout(watchdog); resolve({timedOut: false, error: String(error)}); });
    });
    check("live/driverless: mission process exited (no hang)", exit.timedOut !== true, exit);
    const runs = implementerRunDirs(repo);
    check("live/driverless: an implementer run was recorded", runs.length > 0, runs.length);
    const raw = runs.length ? JSON.parse(fs.readFileSync(path.join(runs[0].dir, "status.json"), "utf8")) : null;
    check("live/driverless: status.json usage stays null (never a fabricated zero)",
      raw !== null && raw.usage === null && !("priceWeighted" in (raw.usage ?? {})), raw?.usage);
    if (runs.length) {
      const meta = readRunMeta(runs[0].dir, path.basename(runs[0].dir));
      check("live/driverless: watch cells render - throughout",
        priceCellText(meta) === "-" && turnsCellText(meta) === "-", {price: priceCellText(meta), turns: turnsCellText(meta)});
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Integration R1: a non-implementer role streams live totals ──────────
// code_reviewer on the opencode adapter (same two-wave review scenario).
if (!opencodeHermetic) {
  skips("live/reviewer-totals", "a real opencode binary outscores the fixture shim on this machine; live-usage e2e needs hermetic binary resolution.");
} else {
  const {repo, binDir, mission} = setupLiveMission("live-review", "live_usage_review", {adapter: "cursor", reviewerAdapter: "opencode", reviewerShim: REVIEW_FIXTURE});
  try {
    const {waitExit} = spawnAutopilot(repo, binDir, "live usage probe");
    // Mid-run: the reviewer's first wave (3 turns) persists while the 12s
    // inter-wave sleep holds the review open for observation.
    let midUsage = null;
    for (let i = 0; i < 140 && !midUsage; i += 1) {
      await sleep(250);
      const hit = roleRunDirs(repo, mission, "code_reviewer").find((r) => Number(r.status?.usage?.turns) === 3);
      if (hit) midUsage = hit.status.usage;
    }
    check("live/reviewer-totals: reviewer status.json gains usage mid-run",
      midUsage !== null && midUsage.turns === 3, midUsage);
    // The watch file is a periodically rewritten snapshot: under load it can
    // lag status.json by a refresh, so poll briefly (the 12s sleep holds the
    // review open) instead of reading it once.
    let midLine = roleWatchLine(repo, mission, "code_reviewer");
    for (let i = 0; i < 24 && !(midLine && midLine.includes("~")); i += 1) {
      await sleep(250);
      midLine = roleWatchLine(repo, mission, "code_reviewer");
    }
    check("live/reviewer-totals: watch PRICE shows ~… for the running review",
      midLine !== null && midLine.includes("~"), midLine);
    const exit = await waitExit;
    check("live/reviewer-totals: mission process exited (no hang)", exit.timedOut !== true, exit);
    const final = roleRunDirs(repo, mission, "code_reviewer")[0];
    check("live/reviewer-totals: finalized totals cover both waves",
      final?.status?.usage?.turns === 6 && final?.status?.usage?.priceWeighted === 210,
      final?.status?.usage);
    const finalLine = roleWatchLine(repo, mission, "code_reviewer");
    check("live/reviewer-totals: watch shows plain totals after finalize (no ~)",
      finalLine !== null && finalLine.includes("210") && !finalLine.includes("~"), finalLine);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Integration R2: caps never touch a non-implementer role ──────────────
// Same reviewer stream, but per_task_max_turns: 5 — the 6-turn review would
// breach if caps applied. It must complete unkilled with no result.capped.
if (!opencodeHermetic) {
  skips("live/reviewer-cap-isolation", "a real opencode binary outscores the fixture shim on this machine; live-usage e2e needs hermetic binary resolution.");
} else {
  const {repo, binDir, mission} = setupLiveMission("live-review-cap", "live_usage_review",
    {adapter: "cursor", reviewerAdapter: "opencode", reviewerShim: REVIEW_FIXTURE, policyExtra: {per_task_max_turns: 5, per_task_max_tokens: 100000000}});
  try {
    const {waitExit} = spawnAutopilot(repo, binDir, "live usage probe");
    const exit = await waitExit;
    check("live/reviewer-cap-isolation: mission process exited (no hang)", exit.timedOut !== true, exit);
    const reviews = roleRunDirs(repo, mission, "code_reviewer");
    check("live/reviewer-cap-isolation: a review ran", reviews.length > 0, reviews.length);
    const results = reviews.map((r) => {
      try { return JSON.parse(fs.readFileSync(path.join(r.dir, "result.json"), "utf8")); }
      catch { return null; }
    }).filter(Boolean);
    check("live/reviewer-cap-isolation: no review carries result.capped (never killed, never flagged)",
      results.length > 0 && results.every((data) => !("capped" in (data ?? {}))),
      results.map((data) => ({capped: data?.capped ?? null})));
    check("live/reviewer-cap-isolation: the over-cap review still PASSED",
      results.some((data) => data?.verdict?.decision === "PASS"),
      results.map((data) => data?.verdict?.decision));
    check("live/reviewer-cap-isolation: the mission moved on to verification",
      roleRunDirs(repo, mission, "verifier").length > 0,
      roleRunDirs(repo, mission, "verifier").length);
  } finally {
    cleanup(repo, binDir);
  }
}

// ── Integration R3: driverless non-implementer stays -, no fabrication ───
{
  const {repo, binDir, mission} = setupLiveMission("live-review-driverless", "success", {adapter: "cursor"});
  try {
    const {waitExit} = spawnAutopilot(repo, binDir, "live usage probe");
    const exit = await waitExit;
    check("live/reviewer-driverless: mission process exited (no hang)", exit.timedOut !== true, exit);
    const reviews = roleRunDirs(repo, mission, "code_reviewer");
    check("live/reviewer-driverless: a review ran", reviews.length > 0, reviews.length);
    const allNull = reviews.every((r) => {
      try { return JSON.parse(fs.readFileSync(path.join(r.dir, "status.json"), "utf8")).usage === null; }
      catch { return false; }
    });
    check("live/reviewer-driverless: every review status.json usage stays null",
      reviews.length > 0 && allNull, reviews.length);
    if (reviews.length) {
      const meta = readRunMeta(reviews[0].dir, path.basename(reviews[0].dir));
      check("live/reviewer-driverless: watch cells render - throughout",
        priceCellText(meta) === "-" && turnsCellText(meta) === "-", {price: priceCellText(meta), turns: turnsCellText(meta)});
    }
  } finally {
    cleanup(repo, binDir);
  }
}

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
