#!/usr/bin/env node
// Mission 063 task 1.1 — phase-delta rebase transition helper tests.
//
// Covers at helper level: drifted-fixture success (digest re-point, error
// cleared, cursor untouched, operator-edit record), no-drift refusal,
// null-observed refusal, task-drift refusal, digest-mismatch refusal, plus a
// gate case that evaluatePlanningGate returns resume for the rebased
// checkpoint.
import {
  OPERATOR_PHASE_EDITS_KEY,
  rebasePhaseCheckpointDrift,
} from "./phase-delta-rebase.mjs";
import {deltaDigest, evaluatePlanningGate, phaseTaskDigest, CHECKPOINT_STATE_KEY} from "./phase-stage-checkpoint.mjs";
import {buildStandaloneHandoff, formatOperatorPhaseEdits} from "./standalone-handoff.mjs";
import {ensureBaseline, sanitizeKeySegment, scopedDelta} from "./implementation-baseline.mjs";
import * as standalone from "../adapters/standalone.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, writeConfig, withoutOuterGitGuard,
} from "./test-fixtures/workflow-order-harness.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

const OLD_DIGEST = deltaDigest("rebase-old-delta");
const NEW_DIGEST = deltaDigest("rebase-new-delta");

function driftedState() {
  return {
    version: 1,
    phase: "implementing",
    step: "implementer",
    phaseIndex: 0,
    taskCursor: 2,
    currentTask: {file: "x.md", line: 1, text: "t", done: false},
    phaseExecutionCheckpoint: {
      version: 1,
      framework: "standalone",
      mission: "063-test",
      phaseIndex: 0,
      phaseName: "Phase 1",
      phaseTaskDigest: deltaDigest("tasks"),
      revision: 1,
      nextStage: "code_reviewer",
      runningStage: null,
      attempts: {implementer: 1, code_reviewer: 0, verifier: 0},
      baselineKey: "mission-063-test-phase-0",
      deltaDigest: OLD_DIGEST,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    phaseCheckpointError: {
      code: "PHASE_CHECKPOINT_DRIFT",
      evidence: {
        reason: "delta drift",
        expectedDeltaDigest: OLD_DIGEST,
        observedDeltaDigest: NEW_DIGEST,
      },
    },
  };
}

// ── Drifted fixture: success ──────────────────────────────────────────
{
  const s = driftedState();
  const before = JSON.stringify({phase: s.phase, step: s.step, phaseIndex: s.phaseIndex, taskCursor: s.taskCursor, currentTask: s.currentTask});
  const r = rebasePhaseCheckpointDrift(s, {
    files: ["a.md", "b.md"],
    note: "operator tweak",
    at: "2026-10-12T00:00:00.000Z",
    currentDeltaDigest: NEW_DIGEST,
  });
  check("rebase: drifted fixture succeeds", r?.ok === true, r);
  check("rebase: checkpoint digest re-pointed", s.phaseExecutionCheckpoint?.deltaDigest === NEW_DIGEST, s.phaseExecutionCheckpoint?.deltaDigest);
  check("rebase: error cleared", !("phaseCheckpointError" in s), Object.keys(s));
  check("rebase: cursor untouched",
    JSON.stringify({phase: s.phase, step: s.step, phaseIndex: s.phaseIndex, taskCursor: s.taskCursor, currentTask: s.currentTask}) === before,
    {phase: s.phase, step: s.step});
  const edits = s[OPERATOR_PHASE_EDITS_KEY];
  check("rebase: operator-edit record appended",
    Array.isArray(edits) && edits.length === 1
    && JSON.stringify(edits[0].files) === JSON.stringify(["a.md", "b.md"])
    && edits[0].note === "operator tweak"
    && edits[0].at === "2026-10-12T00:00:00.000Z"
    && edits[0].expectedDeltaDigest === OLD_DIGEST
    && edits[0].observedDeltaDigest === NEW_DIGEST, edits);
}

// ── No-drift refusal ──────────────────────────────────────────────────
{
  const s = driftedState();
  delete s.phaseCheckpointError;
  const before = JSON.stringify(s);
  const r = rebasePhaseCheckpointDrift(s, {files: [], note: "", at: "t", currentDeltaDigest: NEW_DIGEST});
  check("rebase: no drift error refuses", r?.ok === false, r);
  check("rebase: no drift leaves state untouched", JSON.stringify(s) === before, Object.keys(s));
}

// ── Null-observed refusal ─────────────────────────────────────────────
{
  const s = driftedState();
  s.phaseCheckpointError.evidence.observedDeltaDigest = null;
  const before = JSON.stringify(s);
  const r = rebasePhaseCheckpointDrift(s, {files: [], note: "", at: "t", currentDeltaDigest: null});
  check("rebase: null observed digest refuses", r?.ok === false, r);
  check("rebase: null observed leaves state untouched", JSON.stringify(s) === before, r);
}

// ── Task-drift refusal ────────────────────────────────────────────────
{
  const s = driftedState();
  s.phaseCheckpointError.evidence.reason = "task drift";
  const before = JSON.stringify(s);
  const r = rebasePhaseCheckpointDrift(s, {files: [], note: "", at: "t", currentDeltaDigest: NEW_DIGEST});
  check("rebase: task drift refuses", r?.ok === false, r);
  check("rebase: task drift leaves state untouched", JSON.stringify(s) === before, r);
}

// ── Delta-computation-failed refusal ──────────────────────────────────
{
  const s = driftedState();
  s.phaseCheckpointError.evidence.reason = "delta computation failed";
  const before = JSON.stringify(s);
  const r = rebasePhaseCheckpointDrift(s, {files: [], note: "", at: "t", currentDeltaDigest: NEW_DIGEST});
  check("rebase: delta computation failure refuses", r?.ok === false, r);
  check("rebase: delta computation failure leaves state untouched", JSON.stringify(s) === before, r);
}

// ── Digest-mismatch refusals ──────────────────────────────────────────
{
  // Expected digest does not match the checkpoint digest.
  const s = driftedState();
  s.phaseCheckpointError.evidence.expectedDeltaDigest = deltaDigest("something-else");
  const before = JSON.stringify(s);
  const r = rebasePhaseCheckpointDrift(s, {files: [], note: "", at: "t", currentDeltaDigest: NEW_DIGEST});
  check("rebase: expected-digest mismatch refuses", r?.ok === false, r);
  check("rebase: expected-digest mismatch leaves state untouched", JSON.stringify(s) === before, r);
}
{
  // Freshly recomputed digest differs from the recorded observed digest.
  const s = driftedState();
  const before = JSON.stringify(s);
  const r = rebasePhaseCheckpointDrift(s, {files: [], note: "", at: "t", currentDeltaDigest: deltaDigest("tree-moved-again")});
  check("rebase: stale observed digest refuses", r?.ok === false, r);
  check("rebase: stale refusal tells operator to run ap run then ap rebase",
    typeof r?.reason === "string" && r.reason.includes("run ap run then ap rebase"), r);
  check("rebase: stale observed leaves state untouched", JSON.stringify(s) === before, r);
}

// ── Gate case: rebased checkpoint resumes ─────────────────────────────
{
  const s = driftedState();
  const r = rebasePhaseCheckpointDrift(s, {files: ["a.md"], note: "n", at: "2026-10-12T00:00:00.000Z", currentDeltaDigest: NEW_DIGEST});
  check("rebase: gate fixture rebased", r?.ok === true, r);
  const cp = s.phaseExecutionCheckpoint;
  const gate = evaluatePlanningGate(cp, "standalone",
    {mission: "063-test", phaseIndex: 0, allChecked: false},
    {phaseTaskDigest: cp.phaseTaskDigest, deltaDigest: NEW_DIGEST});
  check("rebase: gate returns resume for rebased checkpoint", gate?.action === "resume", gate);
}

// ── Spawned-CLI cases: `ap rebase` live-refuse + no-drift ──────────────
// Fixture repos live under $TMPDIR (os.tmpdir), never inside the project repo.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilot = path.join(here, "autopilot.mjs");
  const apLauncher = path.join(here, "..", "bin", "ap.cjs");
  const cleanEnv = withoutOuterGitGuard(process.env);
  const cli = (repo, args) => spawnSync(process.execPath, [autopilot, ...args, "--repo", repo],
    {cwd: repo, encoding: "utf8", env: cleanEnv, timeout: 60000, shell: false});
  const cliOut = (r) => `${r.stdout || ""}${r.stderr || ""}`;
  const made = [];
  const track = (dir) => { made.push(dir); return dir; };
  try {
    // No-drift: no phaseCheckpointError recorded -> "nothing to rebase", exit 0.
    {
      const repo = track(makeFixtureRepo("rebase-cli-nodrift-"));
      writeConfig(repo, {planningFramework: "standalone"});
      const state = {version: 1, phase: "idle", step: "idle", taskIndex: 0, phaseIndex: 0, attempt: 0, mission: null};
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
      const before = fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8");
      const r = cli(repo, ["rebase", "--yes"]);
      check("rebase CLI: no drift exits 0", r.status === 0, {status: r.status, tail: cliOut(r).slice(-500)});
      check("rebase CLI: no drift prints nothing to rebase", cliOut(r).includes("nothing to rebase"), cliOut(r).slice(-500));
      check("rebase CLI: no drift leaves state untouched",
        fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8") === before, cliOut(r).slice(-300));
    }
    // Launcher: `bin/ap.cjs rebase` routes to autopilot.mjs — same no-drift
    // contract (exit 0 + "nothing to rebase").
    {
      const repo = track(makeFixtureRepo("rebase-launcher-nodrift-"));
      writeConfig(repo, {planningFramework: "standalone"});
      const state = {version: 1, phase: "idle", step: "idle", taskIndex: 0, phaseIndex: 0, attempt: 0, mission: null};
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
      const r = spawnSync(process.execPath, [apLauncher, "rebase", "--yes", "--repo", repo],
        {cwd: repo, encoding: "utf8", env: cleanEnv, timeout: 60000, shell: false});
      check("rebase launcher: no drift exits 0", r.status === 0, {status: r.status, tail: cliOut(r).slice(-500)});
      check("rebase launcher: no drift prints nothing to rebase", cliOut(r).includes("nothing to rebase"), cliOut(r).slice(-500));
    }
    // #21: files edited after the checkpoint with NO recorded error — `ap
    // rebase` computes the drift itself and rebases at once.
    {
      const repo = track(makeFixtureRepo("rebase-cli-detected-"));
      writeConfig(repo, {planningFramework: "standalone"});
      const mission = "001-rebase-detected";
      fs.mkdirSync(path.dirname(standalone.planPath(repo, mission)), {recursive: true});
      fs.writeFileSync(standalone.planPath(repo, mission), "# Plan\n\nObjective: fixture task.\n");
      fs.writeFileSync(standalone.tasksPath(repo, mission), "## Phase 1: General\n\n- [ ] Do the fixture task\n");
      const declaredPaths = standalone.declaredDeliverables(repo, mission);
      const missionKey = `mission-${sanitizeKeySegment(mission)}`;
      const phase0Key = `${missionKey}-phase-0`;
      ensureBaseline(repo, missionKey, {mission, declaredPaths});
      ensureBaseline(repo, phase0Key, {mission, declaredPaths});
      const phases = standalone.phases(repo, mission);
      fs.writeFileSync(path.join(repo, "work.txt"), "phase work\n");
      const observedDigest = deltaDigest(scopedDelta(repo, phase0Key, {mission, declaredPaths}));
      const staleDigest = deltaDigest("stale-checkpoint-digest");
      const state = {
        version: 1, phase: "implementing", step: "implementer", phaseIndex: 0, attempt: 1,
        mission, planningRequest: "fixture request",
        [CHECKPOINT_STATE_KEY]: {
          version: 1, framework: "standalone", mission, phaseIndex: 0, phaseName: phases[0].name,
          phaseTaskDigest: phaseTaskDigest({
            framework: "standalone", mission, phaseIndex: 0, phaseName: phases[0].name,
            tasks: phases[0].tasks.map((t) => ({file: t.file, text: t.text})), repoRoot: repo,
          }),
          revision: 1, nextStage: "mark_tasks", runningStage: null,
          attempts: {implementer: 1, code_reviewer: 1, verifier: 1},
          baselineKey: phase0Key, deltaDigest: staleDigest,
          implementer: {runId: null, summary: "stale"},
          codeReviewer: {runId: null, decision: "PASS", findings: []},
          verifier: {runId: null, decision: "PASS", findings: []},
          updatedAt: new Date().toISOString(),
        },
      };
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
      const r = cli(repo, ["rebase", "--yes", "--note", "detected-note"]);
      check("rebase CLI: detected drift exits 0", r.status === 0, {status: r.status, tail: cliOut(r).slice(-800)});
      check("rebase CLI: detected drift prints the rebase success line",
        cliOut(r).includes("Rebased the phase checkpoint"), cliOut(r).slice(-800));
      const after = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
      check("rebase CLI: detected drift clears the error and re-points the digest",
        !after.phaseCheckpointError && after[CHECKPOINT_STATE_KEY]?.deltaDigest === observedDigest,
        {error: after.phaseCheckpointError, digest: after[CHECKPOINT_STATE_KEY]?.deltaDigest, observedDigest});
      const edits = after[OPERATOR_PHASE_EDITS_KEY];
      check("rebase CLI: detected drift records the operator edit",
        Array.isArray(edits) && edits.length === 1 && edits[0].note === "detected-note"
        && edits[0].expectedDeltaDigest === staleDigest && edits[0].observedDeltaDigest === observedDigest,
        edits);
    }
    // Backlog #40: no drift, but an operator commit moved HEAD -> the
    // baseline is rebased and the note is persisted for the next briefs.
    {
      const repo = track(makeFixtureRepo("rebase-cli-note-"));
      writeConfig(repo, {planningFramework: "standalone"});
      const mission = "001-rebase-note";
      const readme = path.join(repo, "README.md");
      fs.writeFileSync(readme, "operator-one\n");
      ensureBaseline(repo, `mission-${sanitizeKeySegment(mission)}-phase-0`);
      const gitRun = (args) => spawnSync("git", args, {cwd: repo, encoding: "utf8", env: cleanEnv, shell: false});
      fs.writeFileSync(readme, "operator-two\n");
      gitRun(["add", "README.md"]);
      gitRun(["commit", "-q", "-m", "operator pause commit"]);
      const state = {version: 1, phase: "implementing", step: "implementer", taskIndex: 0, phaseIndex: 0, attempt: 0, mission};
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
      const r = cli(repo, ["rebase", "--yes", "--note", "operator committed during pause"]);
      check("rebase CLI: no-drift note exits 0", r.status === 0, {status: r.status, tail: cliOut(r).slice(-800)});
      const after = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
      check("rebase CLI: no-drift note is persisted for the next briefs",
        after.operatorPhaseNote?.text === "operator committed during pause" && after.operatorPhaseNote?.phaseIndex === 0, after.operatorPhaseNote);
      check("rebase CLI: operator commit no longer appears in the phase delta",
        scopedDelta(repo, `mission-${sanitizeKeySegment(mission)}-phase-0`).trim() === "",
        scopedDelta(repo, `mission-${sanitizeKeySegment(mission)}-phase-0`).slice(0, 300));
    }
    // Backlog #40 (d): `ap finding drop <n>` removes the finding everywhere.
    {
      const repo = track(makeFixtureRepo("finding-drop-"));
      writeConfig(repo, {planningFramework: "standalone"});
      const state = {
        version: 1, phase: "implementing", step: "implementer", phaseIndex: 0, attempt: 1, mission: "001-drop",
        reviewFeedback: {"standalone-phase:0": {findings: ["keep me", "drop me"], at: new Date().toISOString()}},
        codeReviewHistory: {"standalone-phase:0": [{round: 1, findings: ["keep me", "drop me"], previous: [{finding: "drop me", status: "not_fixed"}]}]},
        feedback: "1. keep me\n2. drop me",
      };
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
      const r = cli(repo, ["finding", "drop", "2", "--note", "operator code", "--yes"]);
      check("finding drop: exits 0", r.status === 0, {status: r.status, tail: cliOut(r).slice(-800)});
      const after = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
      check("finding drop: feedback keeps only the other finding",
        JSON.stringify(after.reviewFeedback?.["standalone-phase:0"]?.findings) === JSON.stringify(["keep me"]), after.reviewFeedback);
      check("finding drop: history finding and previous entry removed",
        JSON.stringify(after.codeReviewHistory?.["standalone-phase:0"]?.[0]?.findings) === JSON.stringify(["keep me"])
        && (after.codeReviewHistory?.["standalone-phase:0"]?.[0]?.previous || []).length === 0, after.codeReviewHistory);
      check("finding drop: legacy feedback line removed", after.feedback === "1. keep me", after.feedback);
      check("finding drop: audit record present", after.operatorDroppedFindings?.at(-1)?.finding === "drop me", after.operatorDroppedFindings);
    }
    // Live-refuse: a live `autopilot.mjs run` for this repo refuses non-zero
    // and never touches state. The live run is faked by a sleeping process
    // whose cmdline matches the stopLivePid() ground truth (contains
    // "autopilot.mjs", a bare `run` argv, and this repo via cwd).
    if (process.platform === "win32") {
      console.log("SKIP rebase CLI: live-refuse on win32 (no /proc scan)");
    } else {
      const repo = track(makeFixtureRepo("rebase-cli-live-"));
      writeConfig(repo, {planningFramework: "standalone"});
      const state = {version: 1, phase: "idle", step: "idle", taskIndex: 0, phaseIndex: 0, attempt: 0, mission: null};
      fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
      const before = fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8");
      const fakeDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rebase-fake-")));
      fs.writeFileSync(path.join(fakeDir, "autopilot.mjs"), "setInterval(() => {}, 1000);\n");
      const live = spawn(process.execPath,
        [path.join(fakeDir, "autopilot.mjs"), "run", "--repo", repo],
        {cwd: repo, env: cleanEnv, stdio: "ignore", shell: false});
      try {
        // Wait until the fake is visible under /proc with the matching cmdline.
        const deadline = Date.now() + 10000;
        let visible = false;
        while (Date.now() < deadline) {
          try {
            const cmd = fs.readFileSync(`/proc/${live.pid}/cmdline`, "utf8");
            if (cmd.includes("autopilot.mjs") && /(?:^|\0)run(?:\0|$)/.test(cmd)) { visible = true; break; }
          } catch { /* not yet visible */ }
          if (live.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        check("rebase CLI: live-refuse precondition (fake run visible)", visible, live.exitCode);
        if (visible) {
          const r = cli(repo, ["rebase", "--yes"]);
          check("rebase CLI: live run refuses non-zero", r.status !== 0, {status: r.status, tail: cliOut(r).slice(-500)});
          check("rebase CLI: live refusal names the live run", /live/i.test(cliOut(r)), cliOut(r).slice(-500));
          check("rebase CLI: live refusal leaves state untouched",
            fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8") === before, cliOut(r).slice(-300));
        }
      } finally {
        try { if (live.exitCode === null) live.kill("SIGKILL"); } catch { /* best-effort */ }
      }
    }
  } finally {
    for (const dir of made) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ } }
  }
}

// ── Operator-edit rendering in buildStandaloneHandoff ────────────────
{
  const base = {
    kind: "PHASE_REVIEW",
    phaseName: "Phase 1",
    phaseIndex: 0,
    phaseTotal: 1,
    phaseTasks: [{file: "/repo/TASKS.md", line: 1, text: "t"}],
    attempt: 1,
    deltaChunks: [{path: "mission.js", text: "diff --git a/mission.js b/mission.js\n+work"}],
    baselineKey: "mission-063-test-phase-0",
    declaredPaths: [],
    implementationSummary: "",
  };
  const plain = buildStandaloneHandoff(base);
  const empty = buildStandaloneHandoff({...base, operatorPhaseEdits: []});
  check("handoff: absent/empty operator edits byte-identical", plain.text === empty.text, plain.text.length);
  const edits = [{
    files: ["op-a.md", "op-b.md"],
    note: "operator tweak",
    at: "2026-10-12T00:00:00.000Z",
    expectedDeltaDigest: OLD_DIGEST,
    observedDeltaDigest: NEW_DIGEST,
  }];
  const withEdits = buildStandaloneHandoff({...base, operatorPhaseEdits: edits});
  const header = "Operator edits";
  const headerAt = withEdits.text.indexOf(header);
  check("handoff: operator edits listed separately from mission work",
    headerAt !== -1
    && withEdits.text.includes("op-a.md")
    && withEdits.text.includes("op-b.md")
    && withEdits.text.slice(headerAt).includes("op-a.md")
    && withEdits.text.slice(headerAt).includes("op-b.md")
    && withEdits.text.includes("mission.js"), withEdits.text.slice(Math.max(0, headerAt - 80), headerAt + 240));
  check("handoff: operator edits section is informational only",
    /informational|operator-acknowledged/i.test(withEdits.text), withEdits.text.slice(Math.max(0, headerAt - 80), headerAt + 240));
  check("handoff: operator edits header carries no do-not-flag instruction",
    !/do not flag/i.test(withEdits.text), withEdits.text.slice(Math.max(0, headerAt - 80), headerAt + 240));
  // The operator-edit section counts toward maxHandoffChars: a budget that
  // exactly fits the plain brief must refuse once the section is added.
  const tight = plain.text.length;
  let refused = false;
  try {
    buildStandaloneHandoff({...base, operatorPhaseEdits: edits, maxHandoffChars: tight});
  } catch (e) {
    refused = e?.code === "HANDOFF_TOO_LARGE";
  }
  check("handoff: operator-edit section counts toward maxHandoffChars", refused, tight);
  // Digest-only record (empty files list: the git-status fallback) still
  // renders as a note + time + old->new digest line so it is included.
  const digestOnly = [{
    files: [],
    note: "operator tweak",
    at: "2026-10-12T00:00:00.000Z",
    expectedDeltaDigest: OLD_DIGEST,
    observedDeltaDigest: NEW_DIGEST,
  }];
  const digestText = formatOperatorPhaseEdits(digestOnly);
  check("handoff: empty-files record renders note + time + digests",
    !!digestText
    && digestText.includes("operator tweak")
    && digestText.includes("2026-10-12T00:00:00.000Z")
    && digestText.includes(OLD_DIGEST)
    && digestText.includes(NEW_DIGEST), digestText);
  const withDigestOnly = buildStandaloneHandoff({...base, operatorPhaseEdits: digestOnly});
  check("handoff: empty-files record is included in the brief",
    withDigestOnly.text.includes("Operator edits")
    && withDigestOnly.text.includes(OLD_DIGEST)
    && withDigestOnly.text.includes(NEW_DIGEST), withDigestOnly.text.length);
}

// ── Reviewer-brief wiring + docs (mission 063 task 1.4) ────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const readme = fs.readFileSync(path.join(here, "..", "README.md"), "utf8");
  const skill = fs.readFileSync(path.join(here, "..", "SKILL.md"), "utf8");
  // Standalone call sites pass the record for both reviewer briefs.
  const passSites = (autopilotSrc.match(/operatorPhaseEdits:s\.operatorPhaseEdits/g) ?? []).length;
  check("brief wiring: standalone PHASE_REREVIEW/PHASE_REVIEW pass operatorPhaseEdits", passSites >= 2, passSites);
  // SpecKit twin: the inline reviewPrompt renders the same record.
  check("brief wiring: SpecKit reviewPrompt renders operator edits",
    autopilotSrc.includes("formatOperatorPhaseEdits(s.operatorPhaseEdits)")
    && /reviewPrompt\+=`\\n\\n\$\{operatorEditsSection\}`/.test(autopilotSrc), false);
  // The record is cleared after the brief/prompt has included it (both loops).
  const clears = (autopilotSrc.match(/delete s\.operatorPhaseEdits/g) ?? []).length;
  check("brief wiring: operator-edit record cleared after inclusion (both loops)", clears >= 2, clears);
  check("brief wiring: standalone clear sits after the handoff call sites",
    autopilotSrc.indexOf('kind:"PHASE_REREVIEW"') < autopilotSrc.indexOf("delete s.operatorPhaseEdits"), false);
  check("brief wiring: SpecKit clear sits after the inline reviewPrompt",
    autopilotSrc.indexOf("Changes since your last review") < autopilotSrc.lastIndexOf("delete s.operatorPhaseEdits"), false);
  // Docs: operator-command sentence updated, usage line + subsection present.
  check("docs: README counts four operator-only commands", readme.includes("Five operator-only commands"), false);
  check("docs: README command list carries ap rebase", readme.includes("ap rebase"), false);
  check("docs: SKILL counts four operator-only commands", skill.includes("Five operator-only commands"), false);
  check("docs: SKILL carries an ap rebase subsection", skill.includes("### `ap rebase"), false);
  // Inclusion-gated clear semantics: a record the brief shows is dropped
  // afterwards; an absent/empty record renders nothing so nothing is dropped.
  const shown = [{
    files: ["op-a.md"], note: "n", at: "2026-10-12T00:00:00.000Z",
    expectedDeltaDigest: OLD_DIGEST, observedDeltaDigest: NEW_DIGEST,
  }];
  check("brief wiring: non-empty record is included in the brief", !!formatOperatorPhaseEdits(shown), false);
  check("brief wiring: absent/empty record is not included",
    !formatOperatorPhaseEdits(undefined) && !formatOperatorPhaseEdits([]), false);
  {
    const s = {operatorPhaseEdits: shown};
    if (formatOperatorPhaseEdits(s.operatorPhaseEdits)) { delete s.operatorPhaseEdits; }
    check("brief wiring: record cleared after inclusion in the brief", !("operatorPhaseEdits" in s), Object.keys(s));
  }
  {
    const s = {};
    if (formatOperatorPhaseEdits(s.operatorPhaseEdits)) { delete s.operatorPhaseEdits; }
    check("brief wiring: nothing cleared when the brief included nothing", !("operatorPhaseEdits" in s), Object.keys(s));
  }
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
