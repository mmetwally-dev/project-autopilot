#!/usr/bin/env node
// F2 — `ap cancel`, `ap stop` and `ap reset` (mission-control commands).
//
// Every case is a real subprocess against a throwaway fixture repo with a
// fabricated state.json: nothing touches a live mission and no model is invoked.
// The live-run cases spawn a decoy `node <repo>/autopilot.mjs run` (a sleep,
// killed in `finally`) — the same cmdline shape C3 uses, so the real liveness
// detector trips on POSIX (/proc) and on Windows (CIM command-line query).
//
// Covered:
//   C1  `ap cancel "<reason>"` through the LAUNCHER ends the mission, clears every
//       mission-scoped key, stamps the reason, keeps the mission directory, and
//       does NOT touch failure counters (pinned cross-mission inheritance);
//   C2  after a cancel the state is a clean start for a new mission (the F1 path);
//   C3  `ap cancel --yes` with a live run stops it first (SIGTERM/taskkill),
//       then ends the mission: decoy dead, phase cancelled, scoped keys gone,
//       counters kept, mission directory kept;
//   C6  `ap cancel --dry-run` with a live run previews the kill AND the cancel
//       (plan + live pid) without killing or writing;
//   C7  `ap cancel` with a live run but no TTY and no --yes refuses and kills
//       nothing (the plan is still shown first);
//   S1  `ap stop` with no state file says no mission is running and changes nothing;
//   S2  `ap stop` on a completed mission says the same;
//   S3  `ap stop` on an idle (non-running) mission names it, points at `ap cancel`,
//       and changes nothing;
//   S4  `ap stop` on an already-cancelled mission says so and changes nothing;
//   S5  `ap stop --dry-run` with a live run previews (plan + pid) without killing;
//   S6  `ap stop` with a live run but no TTY and no --yes refuses, kills nothing;
//   S7  `ap stop --yes` with a live run kills it (SIGTERM/taskkill), keeps mission
//       state byte-identical, and prints the resume hint;
//   S8  `ap stop` is dispatched through the launcher and listed in `ap help`;
//   U1  `ap uninstall` is dispatched through the launcher, listed in `ap help`,
//       and routeSubcommand({command:"uninstall"}) neither throws nor delegates;
//   R1  `ap reset` resolves the recorded failure's own budget key, clears it,
//       leaves other keys alone, and records what it overrode;
//   R2  `ap reset --scope <key>` clears a named key;
//   R3  reset touches counters ONLY — position, checkpoints, lastFailure survive;
//   R4  reset with nothing to clear exits non-zero with a usable message;
//   R5  reset while a run is alive QUEUES a request (the live path) instead of
//       refusing, names the key, and does not touch state.json;
//   R6  the watch report shows the reset (live vs stopped) and the cancel.
//
// KEY FORM (this matters, and the first version of this file got it wrong):
// `failureBudgets` is keyed `<budgetName>:<scope>` — e.g.
// `adapterRetryBudget:adapter:opencode:verifier` — while `lastFailureBudget`
// carries `budget: "adapterRetryBudget"` and `scope: "adapter:opencode:verifier"`
// separately. An earlier fixture made key and scope identical, which hid a real
// bug in `ap reset`; the fixture here is the realistic shape.
import fs from "node:fs";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {makeFixtureRepo, writeConfig, cleanup, skillRoot} from "./test-fixtures/workflow-order-harness.mjs";
import {renderWatchReport} from "./run-history.mjs";
import {readResetRequests} from "./reset-request-queue.mjs";
import {routeSubcommand} from "./runtime-mode-router.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const SCOPE = "adapter:opencode:verifier";
const KEY = "adapterRetryBudget:adapter:opencode:verifier";
const OTHER_KEY = "infrastructureRetryBudget:mission";

const SCOPED_KEYS = ["phaseExecutionCheckpoint","checkpoint","phaseCheckpointError","currentPhase","currentTask",
  "feedback","pendingCheckboxSnapshot","lastFailure","lastFailureBudget","relayPolicyViolation",
  "standalonePlanningReviewCheckpoint","speckitGateReviewCheckpoint"];

function readState(repo){ return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8")); }
function writeState(repo, state){ fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2)); }

function escalatedState(){
  const z = `sha256:${"a".repeat(64)}`;
  return {
    version: 1, phase: "escalated", step: "adapterRetryBudget_exhausted", taskIndex: 0, phaseIndex: 4, attempt: 1,
    mission: "999-test-mission", missionSeq: "999", planningRequest: "an older request",
    currentPhase: {name: "Phase 5", tasks: []}, currentTask: {file: "x", line: 1, text: "t", done: false},
    feedback: "", lastFailure: {schema: "autopilot-failure.v1", class: "STRUCTURED_OUTPUT_MISSING", domain: "adapter",
      retryable: false, evidence: [{source: "relay", message: "Review sentinel was not observed."}],
      sourceRole: "verifier", adapter: "opencode"},
    // realistic: the recorded failure names budget + scope, the map is keyed by both
    lastFailureBudget: {allowed: false, budget: "adapterRetryBudget", used: 1, limit: 2, scope: SCOPE},
    failureBudgets: {[KEY]: 1, [OTHER_KEY]: 1},
    relayPolicyViolation: "git_mutation_blocked",
    phaseCheckpointError: {code: "PHASE_CHECKPOINT_DRIFT", evidence: {reason: "delta drift"}},
    phaseExecutionCheckpoint: {version: 1, framework: "standalone", mission: "999-test-mission", phaseIndex: 4,
      phaseName: "Phase 5", phaseTaskDigest: z, revision: 1, nextStage: "verifier", runningStage: "verifier",
      attempts: {implementer: 1, code_reviewer: 1, verifier: 0}, baselineKey: "k", deltaDigest: z},
    checkpoint: {type: "standalone-phase", phase: "Phase 5", index: 4},
    standalonePlanningReviewCheckpoint: {version: 1, framework: "standalone", mission: "999-test-mission",
      position: "reviewer-pending", artifacts: ["a", "b"], artifactDigest: z, updatedAt: "2026-01-01T00:00:00.000Z"},
    speckitGateReviewCheckpoint: {version: 99}
  };
}

function makeRepo(prefix){
  const repo = makeFixtureRepo(prefix);
  writeConfig(repo, {planningFramework: "standalone"});
  const dir = path.join(repo, ".autopilot", "missions", "999-test-mission");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan\n");
  writeState(repo, escalatedState());
  return repo;
}
function apCommand(args, repo){ return [path.join(skillRoot, "bin", "ap.cjs"), ...args, "--repo", repo]; }
function run(args, repo){
  const r = spawnSync(process.execPath, apCommand(args, repo), {encoding: "utf8", shell: false});
  return {status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`};
}
// Deterministic non-TTY stdio: the interactive refusal must not depend on
// whether the test runner itself has a terminal attached.
function runPiped(args, repo){
  const r = spawnSync(process.execPath, apCommand(args, repo), {encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"]});
  return {status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`};
}
// A live run the real detector trips on: a file literally named
// autopilot.mjs launched with a `run` arg (the C3 shape), so /proc cmdline
// matching on POSIX and the CIM command-line query on Windows both see it.
function spawnDecoy(repo){
  const fake = path.join(repo, "autopilot.mjs");
  fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
  return spawn(process.execPath, [fake, "run"], {cwd: repo, stdio: "ignore"});
}
function decoyAlive(child){
  return child.exitCode === null && child.signalCode == null;
}
async function settle(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }
// CIM/WMI visibility for a just-spawned process can lag the spawn by seconds
// on Windows, so a fixed settle races the very detector under test. Poll the
// real detector (read-only `stop --dry-run`, which never touches state)
// until the decoy is visible instead.
async function waitForLive(repo, child, timeoutMs = 20000){
  const start = Date.now();
  for(;;){
    const dry = run(["stop", "--dry-run"], repo);
    if(dry.out.includes("live run:") && dry.out.includes(String(child.pid))) return true;
    if(!decoyAlive(child)) return false;
    if(Date.now() - start > timeoutMs) return false;
    await settle(500);
  }
}

const created = [];
function track(repo){ created.push(repo); return repo; }

try {
  // ---- C1 / C2: cancel through the launcher --------------------------------
  {
    const repo = track(makeRepo("mc-cancel"));
    const r = run(["cancel", "operator testing cancel", "--yes"], repo);
    const s = readState(repo);
    const present = SCOPED_KEYS.filter(k => k in s);
    check("C1 cancel exits 0 through the launcher dispatch", r.status === 0, {status: r.status, out: r.out});
    check("C1 phase/step are cancelled", s.phase === "cancelled" && s.step === "cancelled", {phase: s.phase, step: s.step});
    check("C1 every mission-scoped key is gone", present.length === 0, present);
    check("C1 the reason is recorded",
      s.lastCancelled?.reason === "operator testing cancel" && s.lastCancelled?.previousPhase === "escalated",
      s.lastCancelled);
    check("C1 failure counters are NOT cleared (pinned inheritance)",
      JSON.stringify(s.failureBudgets) === JSON.stringify({[KEY]: 1, [OTHER_KEY]: 1}), s.failureBudgets);
    check("C1 the mission directory is kept as the record",
      fs.existsSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "PLAN.md")));
    check("C2 cancelled is not an 'open work' phase and no checkpoint blocks a new mission",
      !["planning","tasks_ready","implementing","final_review","phase_complete","verifying","wave","escalated"].includes(s.phase)
      && !("phaseExecutionCheckpoint" in s), {phase: s.phase});
  }

  // ---- C4/C5: the confirmation contract on `ap cancel` ---------------------
  // The plan must be printed BEFORE anything is removed, and a non-interactive
  // invocation must never cancel in silence: no TTY and no `--yes` = refuse.
  // (The interactive y/N branch itself needs a real TTY, so it is exercised by
  // hand; everything either side of it is covered here.)
  {
    const repo = track(makeRepo("mc-confirm"));
    const before = JSON.stringify(readState(repo));

    const dry = run(["cancel", "--dry-run"], repo);
    check("C4 --dry-run exits 0, prints the plan, and changes nothing",
      dry.status === 0 && JSON.stringify(readState(repo)) === before && dry.out.includes("--dry-run"),
      {status: dry.status, out: dry.out});
    check("C4 the plan names the target mission and its current phase/step",
      dry.out.includes("mission:      999-test-mission") && dry.out.includes("current:      escalated"),
      dry.out.slice(0, 600));
    check("C4 the plan lists the keys it would clear",
      dry.out.includes("will clear:") && dry.out.includes("phaseExecutionCheckpoint")
      && dry.out.includes("standalonePlanningReviewCheckpoint"), dry.out.slice(0, 600));
    check("C4 the plan says what is NOT touched (files, Git tree, counters)",
      dry.out.includes("will keep:") && dry.out.includes("Git working tree") && dry.out.includes("failure counters"),
      dry.out.slice(0, 600));

    const noYes = run(["cancel"], repo);
    check("C5 without a TTY and without --yes it refuses instead of cancelling",
      noYes.status !== 0 && /not interactive/.test(noYes.out) && /--yes/.test(noYes.out)
      && JSON.stringify(readState(repo)) === before, {status: noYes.status, out: noYes.out});
    check("C5 it still showed the plan before refusing",
      noYes.out.includes("will clear:") && noYes.out.includes("mission:      999-test-mission"),
      noYes.out.slice(0, 600));
  }

  // ---- S1/S2: no mission at all ---------------------------------------------
  {
    const repo = track(makeFixtureRepo("mc-stop-none"));
    writeConfig(repo, {planningFramework: "standalone"});
    try { fs.rmSync(path.join(repo, ".autopilot", "state.json"), {force: true}); } catch {}
    const r = run(["stop"], repo);
    check("S1 stop with no state file says no mission is running",
      r.status === 0 && r.out.includes("No mission is running."), {status: r.status, out: r.out});

    const done = track(makeFixtureRepo("mc-stop-done"));
    writeConfig(done, {planningFramework: "standalone"});
    const s = escalatedState(); s.phase = "complete"; s.step = "human_commit";
    writeState(done, s);
    const r2 = run(["stop"], done);
    check("S2 stop on a completed mission says no mission is running and changes nothing",
      r2.status === 0 && r2.out.includes("No mission is running.") && readState(done).phase === "complete",
      {status: r2.status, out: r2.out});
  }

  // ---- S3/S4: mission exists but idle ---------------------------------------
  {
    const repo = track(makeRepo("mc-stop-idle"));
    const before = JSON.stringify(readState(repo));
    const r = run(["stop"], repo);
    check("S3 stop on an idle mission names it and points at ap cancel",
      r.status === 0 && r.out.includes("exists but isn't running right now") && r.out.includes("ap cancel"),
      {status: r.status, out: r.out});
    check("S3 the idle mission's state is byte-identical",
      JSON.stringify(readState(repo)) === before);

    const s = readState(repo);
    s.phase = "cancelled"; s.step = "cancelled";
    writeState(repo, s);
    const r2 = run(["stop"], repo);
    check("S4 stop on an already-cancelled mission says so",
      r2.status === 0 && r2.out.includes("already cancelled"), {status: r2.status, out: r2.out});
  }

  // ---- S5/S6/S7: live run (decoy trips the real detector) -------------------
  {
    const repo = track(makeRepo("mc-stop-live"));
    const child = spawnDecoy(repo);
    try {
      await settle(400);
      const before = JSON.stringify(readState(repo));

      const dry = run(["stop", "--dry-run"], repo);
      check("S5 dry-run previews the plan with the live pid and kills nothing",
        dry.status === 0 && dry.out.includes("--dry-run") && dry.out.includes("live run:")
        && dry.out.includes(String(child.pid)) && decoyAlive(child)
        && JSON.stringify(readState(repo)) === before, {status: dry.status, out: dry.out});

      const noYes = runPiped(["stop"], repo);
      check("S6 no TTY and no --yes refuses and kills nothing",
        noYes.status !== 0 && /not interactive/.test(noYes.out) && decoyAlive(child)
        && JSON.stringify(readState(repo)) === before, {status: noYes.status, out: noYes.out});

      const go = run(["stop", "--yes"], repo);
      await settle(300);
      check("S7 stop --yes exits 0 and the live run is dead",
        go.status === 0 && !decoyAlive(child), {status: go.status, out: go.out, alive: decoyAlive(child)});
      check("S7 it names the gentle signal and the resume path",
        /SIGTERM|taskkill/.test(go.out) && go.out.includes("ap run"), go.out.slice(0, 800));
      check("S7 mission state is byte-identical (kill + keep)",
        JSON.stringify(readState(repo)) === before, {changed: true});
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  // ---- S9: interactive TTY answer (POSIX, needs util-linux `script`) ---------
  // Seen live through wsl.exe: the Enter that launched `ap stop` leaked into
  // the pty as "\n", the prompt read it as an empty answer, and a typed `y`
  // was never read ("aborted — nothing was changed."). A stale blank line
  // right after the prompt must be skipped; `n` must still abort.
  const hasScript = process.platform !== "win32"
    && spawnSync("script", ["--version"], {encoding: "utf8"}).status === 0;
  if (!hasScript) {
    console.log("SKIP S9 interactive TTY answer (no POSIX `script`)");
  } else {
    // `script` gives ap a real TTY; the answer is fed on its stdin as timed
    // steps ([delayMs, bytes]) so a stale Enter can arrive before the prompt.
    // Spawned directly, never through a `bash -c` string (test-no-unguarded-shell).
    const ttyStop = (repo, steps) => new Promise((resolve) => {
      const cmd = [process.execPath, ...apCommand(["stop"], repo)].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      const child = spawn("script", ["-qfc", cmd, "/dev/null"], {stdio: ["pipe", "pipe", "pipe"], shell: false});
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 30000);
      let at = 0;
      for (const [delayMs, bytes] of steps) {
        at += delayMs;
        setTimeout(() => { try { child.stdin.write(bytes); } catch { /* closed */ } }, at);
      }
      child.on("close", (status) => { clearTimeout(killer); resolve({status, out}); });
    });
    {
      const repo = track(makeRepo("mc-stop-tty-no"));
      const child = spawnDecoy(repo);
      try {
        await settle(400);
        const r = await ttyStop(repo, [[1000, "n\n"]]);
        check("S9 a typed `n` at the TTY prompt aborts and kills nothing",
          /aborted/.test(r.out) && decoyAlive(child), {status: r.status, out: r.out});
      } finally { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
    {
      const repo = track(makeRepo("mc-stop-tty-yes"));
      const child = spawnDecoy(repo);
      try {
        await settle(400);
        const r = await ttyStop(repo, [[0, "\n"], [1500, "y\n"]]);
        await settle(300);
        check("S9 a stale Enter before the prompt is skipped and the typed `y` stops the run",
          !/aborted/.test(r.out) && r.out.includes("ap run") && !decoyAlive(child),
          {status: r.status, out: r.out, alive: decoyAlive(child)});
      } finally { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
    {
      // Seen live through wsl.exe: `y` arrived as "�y" (an invalid byte
      // ahead of the typed answer) and the cancel aborted.
      const repo = track(makeRepo("mc-stop-tty-junk"));
      const child = spawnDecoy(repo);
      try {
        await settle(400);
        const r = await ttyStop(repo, [[1000, Buffer.from([0xff, 0x79, 0x0a])]]);
        await settle(300);
        check("S9 an invalid byte ahead of the typed `y` is ignored and the run stops",
          !/aborted/.test(r.out) && r.out.includes("ap run") && !decoyAlive(child),
          {status: r.status, out: r.out, alive: decoyAlive(child)});
      } finally { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
  }

  // ---- S8: launcher dispatch + help ------------------------------------------
  {
    const launcher = fs.readFileSync(path.join(skillRoot, "bin", "ap.cjs"), "utf8");
    check("S8 the launcher routes ap stop and ap cancel through the runtime-mode router",
      launcher.includes("command === 'stop'") && launcher.includes("command === 'cancel'")
      && launcher.includes("missionControlRoute('stop'") && launcher.includes("missionControlRoute('cancel'"),
      launcher.slice(0, 400));
    const h = run(["help"], track(makeRepo("mc-stop-help")));
    check("S8 ap help lists ap stop and ap cancel", h.status === 0 && h.out.includes("ap stop") && h.out.includes("ap cancel"),
      h.out.slice(0, 400));
  }

  // ---- U1: uninstall launcher dispatch + help + direct routeSubcommand ----
  {
    const launcher = fs.readFileSync(path.join(skillRoot, "bin", "ap.cjs"), "utf8");
    check("U1 the launcher routes ap uninstall through the runtime-mode router",
      launcher.includes("command === 'uninstall'") && launcher.includes("missionControlRoute('uninstall'"),
      launcher.slice(0, 400));
    const h = run(["help"], track(makeRepo("mc-uninstall-help")));
    check("U1 ap help lists ap uninstall", h.status === 0 && h.out.includes("ap uninstall"),
      h.out.slice(0, 400));
    // Backlog #14 task 1.3: the direct router call must accept `uninstall`
    // (the guard at scripts/runtime-mode-router.mjs:400 used to throw) and,
    // with no config present, must resolve locally as setup-required rather
    // than delegating into WSL.
    let threw = null;
    let decision = null;
    try {
      decision = await routeSubcommand({
        command: "uninstall",
        repoArgs: [],
        skillRoot,
        readConfig: () => ({exists: false, config: null})
      });
    } catch (error) {
      threw = error;
    }
    check("U1 routeSubcommand(uninstall) does not throw", threw === null,
      threw ? {message: threw.message} : undefined);
    check("U1 routeSubcommand(uninstall) does not delegate and reports setup-required",
      decision && decision.action !== "delegated" && decision.action === "setup-required"
      && typeof decision.repo === "string", decision);
  }

  // ---- R1 / R3: reset resolves the recorded key, counters only -------------
  {
    const repo = track(makeRepo("mc-reset"));
    const before = readState(repo);
    // Backlog #11: bare `ap reset` is now the global form; the recorded-key
    // single-key behaviour R1/R3 pin is reached with an explicit --scope.
    const r = run(["reset", "--scope", KEY], repo);
    const s = readState(repo);
    check("R1 reset exits 0 and resolves the recorded failure's own budget key", r.status === 0, {status: r.status, out: r.out});
    check("R1 that key is cleared", !(KEY in (s.failureBudgets || {})), s.failureBudgets);
    check("R1 an unrelated key is left alone", s.failureBudgets?.[OTHER_KEY] === 1, s.failureBudgets);
    check("R1 what was overridden is recorded, including the limit",
      s.lastReset?.scope === KEY && s.lastReset?.clearedUsed === 1 && s.lastReset?.clearedLimit === 2
      && s.lastReset?.failure === "STRUCTURED_OUTPUT_MISSING/adapter", s.lastReset);
    check("R1 the overridden failure is echoed to the operator",
      r.out.includes("overriding: STRUCTURED_OUTPUT_MISSING/adapter") && r.out.includes("retryable=false"), r.out);
    check("R3 position, checkpoints and lastFailure survive a reset",
      s.phase === before.phase && s.step === before.step
      && JSON.stringify(s.phaseExecutionCheckpoint) === JSON.stringify(before.phaseExecutionCheckpoint)
      && JSON.stringify(s.lastFailure) === JSON.stringify(before.lastFailure), {phase: s.phase, step: s.step});
    check("R3 reset says out loud that it is counters-only", r.out.includes("counters only"), r.out);
  }

  // ---- R1b: the LIVE reset path reports a configured 0 limit as 0 ----------
  {
    const repo = track(makeRepo("mc-reset-zero"));
    writeConfig(repo, {planningFramework: "standalone", failureBudgets: {adapterRetryBudget: 0}});
    const requestFile = path.join(repo, ".autopilot", "reset-request.json");
    fs.writeFileSync(requestFile, JSON.stringify([{key: KEY, scope: SCOPE, at: "2026-01-01T00:00:00.000Z"}]));
    const moduleUrl = new URL("./autopilot.mjs", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      import {applyPendingBudgetResetForTests} from ${JSON.stringify(moduleUrl)};
      const s = JSON.parse(fs.readFileSync(".autopilot/state.json", "utf8"));
      applyPendingBudgetResetForTests(s, ${JSON.stringify(SCOPE)});
      process.stdout.write("RESULT:" + JSON.stringify(s.lastReset));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {encoding: "utf8", cwd: repo});
    const marker = r.stdout.indexOf("RESULT:");
    let reset = null;
    if (marker >= 0) { try { reset = JSON.parse(r.stdout.slice(marker + "RESULT:".length)); } catch { reset = null; } }
    check("R1 live reset under a configured 0 limit reports clearedLimit 0 (not null or \"?\")",
      r.status === 0 && reset?.scope === KEY && reset?.clearedLimit === 0,
      {status: r.status, stdout: r.stdout, stderr: r.stderr, reset});
  }

  // ---- R2: named key ------------------------------------------------------
  {
    const repo = track(makeRepo("mc-reset-scope"));
    const r = run(["reset", "--scope", OTHER_KEY], repo);
    const s = readState(repo);
    check("R2 --scope clears the named key, not the recorded one",
      r.status === 0 && !(OTHER_KEY in (s.failureBudgets || {})) && s.failureBudgets?.[KEY] === 1, s.failureBudgets);
    check("R2 the named key is what gets stamped", s.lastReset?.scope === OTHER_KEY, s.lastReset);
  }

  // ---- R7/R8/R9: `ap reset` for continuations (backlog #27) ----------------
  const CONT_SCOPE = "task:standalone:phase-1:MYTASK";
  const CONT_KEY = `continuationAllowance:${CONT_SCOPE}`;
  function contState(extra = {}) {
    const s = escalatedState();
    delete s.lastFailureBudget;
    s.step = "standalone_task_not_converging";
    s.continuationBudgets = {[CONT_KEY]: 6};
    s.rolloverDeadEnds = {[CONT_KEY]: Array.from({length: 5}, (_, i) => ({generation: i + 1, reason: "turns", used: 40 + i, limit: 40, tail: `dead end ${i + 1}`}))};
    s.lastContinuation = {key: CONT_KEY, scope: CONT_SCOPE, taskId: "MYTASK", mission: "999-test-mission", taskRef: "T9", at: "2026-09-29T00:00:00.000Z"};
    return {...s, ...extra};
  }
  function makeContRepo(prefix, extra) {
    const repo = track(makeRepo(prefix));
    writeState(repo, contState(extra));
    fs.mkdirSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "handoff"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "handoff", "T9.md"), "1. Done — x\n");
    return repo;
  }
  for (const [form, scopeArg] of [["full key", CONT_KEY], ["scope", CONT_SCOPE], ["bare task id", "MYTASK"]]) {
    const repo = makeContRepo(`mc-reset-cont-${form.replace(/ /g, "-")}`);
    const before = readState(repo);
    const r = run(["reset", "--scope", scopeArg], repo);
    const s = readState(repo);
    check(`R7 reset --scope <${form}> exits 0 and prints counts`,
      r.status === 0 && r.out.includes(`Reset '${CONT_KEY}': cleared allowance 6/5 and 5 dead-end entries.`), {status: r.status, out: r.out});
    check(`R7 <${form}> clears allowance and dead-ends`,
      !((s.continuationBudgets || {})[CONT_KEY]) && !((s.rolloverDeadEnds || {})[CONT_KEY]), {budgets: s.continuationBudgets, dead: s.rolloverDeadEnds});
    check(`R7 <${form}> stamps lastReset, drops the recorded continuation`,
      s.lastReset?.scope === CONT_KEY && s.lastReset?.clearedUsed === 6 && s.lastContinuation === undefined, {lastReset: s.lastReset, lastCont: s.lastContinuation});
    check(`R7 <${form}> leaves failureBudgets and stage position untouched`,
      JSON.stringify(s.failureBudgets) === JSON.stringify(before.failureBudgets)
      && s.phase === before.phase && s.step === before.step, {budgets: s.failureBudgets, phase: s.phase});
    check(`R7 <${form}> keeps the hand-off note and says so`,
      fs.existsSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "handoff", "T9.md"))
      && r.out.includes("handoff/T9.md") && r.out.includes("never cleared by reset"), r.out);
  }
  {
    // R8: no --scope after a not-converging escalation targets the recorded continuation.
    const repo = makeContRepo("mc-reset-cont-auto");
    const r = run(["reset"], repo);
    const s = readState(repo);
    // Backlog #11: bare reset is global now, so it clears the continuation
    // (and everything else spent) and stamps lastReset.scope "global".
    check("R8 bare reset (global) clears the escalation-recorded continuation",
      r.status === 0 && !((s.continuationBudgets || {})[CONT_KEY]) && !((s.rolloverDeadEnds || {})[CONT_KEY])
      && s.lastReset?.scope === "global", {status: r.status, out: r.out, reset: s.lastReset});
  }
  {
    // R9: a bare id matching several continuations refuses with disambiguation.
    const repo = makeContRepo("mc-reset-cont-ambiguous");
    const s = readState(repo);
    s.continuationBudgets["continuationAllowance:task:standalone:phase-0:MYTASK"] = 2;
    s.rolloverDeadEnds["continuationAllowance:task:standalone:phase-0:MYTASK"] = [{generation: 1, reason: "turns", used: 41, limit: 40, tail: "x"}];
    writeState(repo, s);
    const r = run(["reset", "--scope", "MYTASK"], repo);
    const after = readState(repo);
    check("R9 ambiguous bare id exits non-zero and names the matches",
      r.status !== 0 && r.out.includes("disambiguate")
      && (after.continuationBudgets || {})[CONT_KEY] === 6, {status: r.status, out: r.out});
  }

  // ---- R7p/R8p: `ap reset` for planning continuations (031 P7.4) ------------
  // Planning scopes have no `phase-N` segment
  // (`task:standalone:planning:planner`, `task:standalone:planning:plan_reviewer`):
  // the full key, the scope, and the bare role id must all resolve, and a bare
  // `ap reset` must auto-target the escalation-recorded planning continuation.
  const PLAN_SCOPES = {
    planner: "task:standalone:planning:planner",
    plan_reviewer: "task:standalone:planning:plan_reviewer",
  };
  function planContState(role) {
    const scope = PLAN_SCOPES[role];
    const key = `continuationAllowance:${scope}`;
    const taskRef = `standalone-planning-${role}`;
    const s = escalatedState();
    delete s.lastFailureBudget;
    s.step = "standalone_planning_no_progress";
    s.continuationBudgets = {[key]: 3};
    s.rolloverDeadEnds = {[key]: [{generation: 1, reason: "turns", used: 40, limit: 40, tail: "dead end 1"}]};
    s.lastContinuation = {key, scope, taskId: null, mission: "999-test-mission", taskRef, at: "2026-09-29T00:00:00.000Z"};
    return {state: s, scope, key, taskRef};
  }
  function makePlanContRepo(prefix, role) {
    const {state, taskRef} = planContState(role);
    const repo = track(makeRepo(prefix));
    writeState(repo, state);
    fs.mkdirSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "handoff"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "handoff", `${taskRef}.md`), "1. Done — x\n");
    return {repo, taskRef};
  }
  for (const role of ["planner", "plan_reviewer"]) {
    const {scope, key} = planContState(role);
    for (const [form, scopeArg] of [["full key", key], ["scope", scope], ["bare role id", role]]) {
      const {repo, taskRef} = makePlanContRepo(`mc-reset-plan-${role}-${form.replace(/ /g, "-")}`, role);
      const before = readState(repo);
      const r = run(["reset", "--scope", scopeArg], repo);
      const s = readState(repo);
      check(`R7p ${role} reset --scope <${form}> exits 0 and prints counts`,
        r.status === 0 && r.out.includes(`Reset '${key}': cleared allowance 3/5 and 1 dead-end entry.`), {status: r.status, out: r.out});
      check(`R7p ${role} <${form}> clears allowance and dead-ends`,
        !((s.continuationBudgets || {})[key]) && !((s.rolloverDeadEnds || {})[key]), {budgets: s.continuationBudgets, dead: s.rolloverDeadEnds});
      check(`R7p ${role} <${form}> stamps lastReset, drops the recorded continuation`,
        s.lastReset?.scope === key && s.lastReset?.clearedUsed === 3 && s.lastContinuation === undefined, {lastReset: s.lastReset, lastCont: s.lastContinuation});
      check(`R7p ${role} <${form}> leaves failureBudgets and stage position untouched`,
        JSON.stringify(s.failureBudgets) === JSON.stringify(before.failureBudgets)
        && s.phase === before.phase && s.step === before.step, {budgets: s.failureBudgets, phase: s.phase});
      check(`R7p ${role} <${form}> keeps the hand-off note and says so`,
        fs.existsSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "handoff", `${taskRef}.md`))
        && r.out.includes(`${taskRef}.md`) && r.out.includes("never cleared by reset"), r.out);
    }
  }
  {
    // R8p: no --scope after a planning not-converging escalation targets the
    // recorded planning continuation.
    const {repo} = makePlanContRepo("mc-reset-plan-auto", "plan_reviewer");
    const key = `continuationAllowance:${PLAN_SCOPES.plan_reviewer}`;
    const r = run(["reset"], repo);
    const s = readState(repo);
    check("R8p bare reset (global, backlog #11) clears the escalation-recorded planning continuation",
      r.status === 0 && !((s.continuationBudgets || {})[key]) && !((s.rolloverDeadEnds || {})[key])
      && s.lastReset?.scope === "global", {status: r.status, out: r.out, reset: s.lastReset});
  }

  // ---- R4: nothing to clear ----------------------------------------------
  {
    const repo = track(makeRepo("mc-reset-empty"));
    const s = readState(repo);
    delete s.lastFailureBudget;
    s.failureBudgets = {};
    writeState(repo, s);
    const r = run(["reset"], repo);
    check("R4 reset with nothing to clear exits non-zero with a usable message",
      r.status !== 0 && r.out.includes("--scope"), {status: r.status, out: r.out});
  }

  // ---- R5 reset QUEUES while live; C6/C7/C3 cancel stops first ------------
  {
    const repo = track(makeRepo("mc-alive"));
    const fake = path.join(repo, "autopilot.mjs");   // cmdline looks like the orchestrator's
    fs.writeFileSync(fake, "setTimeout(()=>{}, 60000);\n");
    const child = spawn(process.execPath, [fake, "run"], {cwd: repo, stdio: "ignore"});
    try {
      await new Promise(resolve => setTimeout(resolve, 400));
      const before = JSON.stringify(readState(repo));
      check("the decoy is visible to the real liveness detector before exercising it",
        await waitForLive(repo, child), {pid: child.pid});

      // Backlog #11: the scoped form keeps the per-key queue entry R5 pins.
      const reset = run(["reset", "--scope", KEY], repo);
      const requestFile = path.join(repo, ".autopilot", "reset-request.json");
        let queued = [];
        try{ queued = readResetRequests(requestFile); }catch{ queued = []; }
        check("R5 reset while alive exits 0 and QUEUES a request instead of refusing",
          reset.status === 0 && reset.out.includes("REQUESTED"), {status: reset.status, out: reset.out});
        check("R5 the queue carries exactly one request naming the resolved budget KEY and its scope",
          queued.length === 1 && queued[0]?.key === KEY && queued[0]?.scope === SCOPE, queued);
      check("R5 the live path does not touch state.json (no lost-update race)",
        JSON.stringify(readState(repo)) === before, {changed: true});
      check("R5 it tells the operator the request is handed to the live run and applies in-process",
        reset.out.includes("handed to that run")
        && reset.out.includes("in the same process: the mission continues instead of escalating"),
        reset.out);
      // Backlog #11: a bare reset while live queues ONE global marker request
      // next to the scoped entry (no state write).
      const gReset = run(["reset"], repo);
      let gQueued = [];
      try{ gQueued = readResetRequests(requestFile); }catch{ gQueued = []; }
      check("R5g bare reset while alive queues one {global:true} request beside the scoped one",
        gReset.status === 0 && gReset.out.includes("Global reset REQUESTED")
        && gQueued.filter(q => q?.global === true).length === 1
        && gQueued.some(q => q?.key === KEY && !q.global)
        && JSON.stringify(readState(repo)) === before, {out: gReset.out, gQueued});

      // C6: dry-run with a live run previews the kill AND the cancel.
      const dry = run(["cancel", "should be previewed", "--dry-run"], repo);
      check("C6 cancel --dry-run with a live run previews the plan and the live pid, kills nothing, changes nothing",
        dry.status === 0 && dry.out.includes("--dry-run") && dry.out.includes("live run:")
        && dry.out.includes(String(child.pid)) && dry.out.includes("will clear:")
        && decoyAlive(child) && JSON.stringify(readState(repo)) === before,
        {status: dry.status, out: dry.out});
      check("C6 the preview says the run will be stopped first and the mission will not resume",
        dry.out.includes("will be stopped first") && dry.out.includes("NOT be resumable"),
        dry.out.slice(0, 900));

      // C7: no TTY + no --yes with a live run refuses (plan shown, nothing killed).
      const noYes = runPiped(["cancel", "should be refused"], repo);
      check("C7 cancel with a live run but no TTY and no --yes refuses and kills nothing",
        noYes.status !== 0 && /not interactive/.test(noYes.out) && decoyAlive(child)
        && JSON.stringify(readState(repo)) === before, {status: noYes.status, out: noYes.out});
      check("C7 it still showed the plan (and the live run) before refusing",
        noYes.out.includes("will clear:") && noYes.out.includes("live run:"),
        noYes.out.slice(0, 900));

      // C3: --yes with a live run stops it first, then ends the mission.
      const go = run(["cancel", "operator stops a live mission", "--yes"], repo);
      await settle(300);
      const s = readState(repo);
      const present = SCOPED_KEYS.filter(k => k in s);
      check("C3 cancel --yes with a live run exits 0 and the live run is dead",
        go.status === 0 && !decoyAlive(child), {status: go.status, out: go.out, alive: decoyAlive(child)});
      check("C3 it names the signal and the kill before the cancel",
        /SIGTERM|taskkill/.test(go.out) && go.out.includes("is gone"), go.out.slice(0, 900));
      check("C3 phase/step are cancelled and every mission-scoped key is gone",
        s.phase === "cancelled" && s.step === "cancelled" && present.length === 0,
        {phase: s.phase, present});
      check("C3 the reason is recorded with the pre-cancel phase",
        s.lastCancelled?.reason === "operator stops a live mission" && s.lastCancelled?.previousPhase === "escalated",
        s.lastCancelled);
      check("C3 failure counters and the mission directory survive the kill-then-cancel",
        JSON.stringify(s.failureBudgets) === JSON.stringify({[KEY]: 1, [OTHER_KEY]: 1})
        && fs.existsSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "PLAN.md")),
        {budgets: s.failureBudgets});
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  // ---- R6: the watch report shows operator interventions -------------------
  {
    const repo = track(makeRepo("mc-report"));
    const s = readState(repo);
    s.phase = "cancelled";
    s.step = "cancelled";
    s.lastCancelled = {at: "2026-09-20T01:05:00.000Z", reason: "operator testing", previousPhase: "escalated",
      previousStep: "adapterRetryBudget_exhausted", mission: "999-test-mission"};
    writeState(repo, s);
    // 094 layout: a live reset now shows through the operator watch-events feed
    // (the PIPELINE STATE `Events:` line), not a standalone `Last reset:` line.
    fs.writeFileSync(path.join(repo, ".autopilot", "missions", "999-test-mission", "watch-events.jsonl"),
      JSON.stringify({type: "operator", reason: "reset", scope: "retries", key: KEY, live: true, at: "2026-09-20T01:02:03.000Z"}) + "\n");
    const report = renderWatchReport(repo, "999-test-mission", {tail: 5});
    check("R6 the watch report shows the reset under Events with its key",
      report.includes("Events:") && report.includes(`operator reset retries (${KEY})`), report.slice(0, 500));
    check("R6 the watch report shows the cancel as Status: CANCELLED with its reason",
      report.includes("CANCELLED") && report.includes("reason: operator testing"), report.slice(0, 500));
    check("R6 the pipeline-state block names the mission and stage",
      /^=== \d{2}:\d{2}:\d{2} — PIPELINE STATE ===$/m.test(report) && /Mission: 999-test-mission/.test(report) && /Stage:/.test(report),
      report.slice(0, 400));
  }
} finally {
  cleanup(...created);
}

if (failures) {
  console.error(`${failures} mission-control check(s) failed.`);
  process.exit(1);
}
console.log("test-mission-control-commands: ALL CHECKS PASSED");
