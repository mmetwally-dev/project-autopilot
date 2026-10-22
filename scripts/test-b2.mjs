#!/usr/bin/env node
// Backlog B2 regression suite: #39 truncated review delta, #40 rebase/notes/
// finding drop, #41 escalation threshold, #42 silent provider limit and
// primary-change-beats-sticky-fallback. Behavioral assertions only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  buildStandaloneHandoff, reviewTruncationResult,
} from "./standalone-handoff.mjs";
import {
  baselineBaseHead, ensureBaseline, headMovedSinceBaseline, rebaseBaselineOntoHead, scopedDelta,
} from "./implementation-baseline.mjs";
import {consecutiveNotFixedReports, scheduleEscalation} from "./escalation-model.mjs";
import {classifyObservedFailure, reclassifySilentOpenCodeFailure} from "./failure-contract.mjs";
import {isExhausted, markExhausted, staleStickyFallback} from "./role-fallback.mjs";
import {DEFAULTS} from "./config-layout.mjs";
import {validateNewConfig} from "./config-validation.mjs";
import {makeFixtureRepo, writeConfig, withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilot = path.join(here, "autopilot.mjs");
const cleanEnv = withoutOuterGitGuard(process.env);
const made = [];
const track = (dir) => { made.push(dir); return dir; };
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}
const git = (repo, args) => spawnSync("git", args, {cwd: repo, encoding: "utf8", env: cleanEnv, shell: false});
const cli = (repo, args) => spawnSync(process.execPath, [autopilot, ...args, "--repo", repo],
  {cwd: repo, encoding: "utf8", env: cleanEnv, timeout: 60000, shell: false});

try {
  // ---- #39 truncated delta: omitted files + run-result fields -------------
  {
    const chunks = [
      {path: "src/a.js", text: `diff --git a/src/a.js b/src/a.js\n${"+a\n".repeat(120)}`},
      {path: "src/b.js", text: `diff --git a/src/b.js b/src/b.js\n${"+b\n".repeat(120)}`},
      {path: "src/c.js", text: `diff --git a/src/c.js b/src/c.js\n${"+c\n".repeat(120)}`},
    ];
    const TASKS = [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}];
    const handoff = buildStandaloneHandoff({kind: "PHASE_REVIEW", phaseName: "p", phaseIndex: 0,
      phaseTotal: 1, phaseTasks: TASKS, attempt: 1, deltaChunks: chunks, baselineKey: "mission-b2-phase-0",
      declaredPaths: [], repoRoot: "/repo", maxDeltaChars: 900, maxHandoffChars: 9000});
    const text = handoff.text;
    check("truncated delta: notice names omitted files", /Omitted files: .*src\/[bc]\.js/.test(text), text.slice(-600));
    check("truncated delta: omitted files carry +/− counts", /src\/[bc]\.js \(\+\d+\/−\d+\)/.test(text), text.slice(-600));
    check("truncated delta: reviewer told to use ranged reads",
      text.includes("Read the omitted files from the worktree with ranged reads"), text.slice(-600));
    check("truncated delta: handoff meta reports chunk counts",
      handoff.meta.truncated === true && handoff.meta.includedChunks + handoff.meta.omittedChunks === 3, handoff.meta);
    const result = reviewTruncationResult(handoff.meta);
    check("truncated delta: result records deltaTruncated",
      result?.deltaTruncated?.kept === handoff.meta.includedChunks
      && result?.deltaTruncated?.omitted === handoff.meta.omittedChunks, result);
    check("truncated delta: result reports reviewed chunk coverage",
      result?.reviewedChunks === `reviewed ${handoff.meta.includedChunks} of 3 chunks`, result);
    check("truncated delta: complete handoff has no truncation result",
      reviewTruncationResult({truncated: false}) === null);
  }

  // ---- #40 a/b: baseHead, operator commit warning data, rebase -----------
  {
    const repo = track(makeFixtureRepo("b2-rebase-"));
    writeConfig(repo, {planningFramework: "standalone"});
    const key = "mission-b2-phase-0";
    fs.writeFileSync(path.join(repo, "README.md"), "operator-one\n");
    ensureBaseline(repo, key);
    const firstHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    check("baseline: baseHead recorded at capture", baselineBaseHead(repo, key) === firstHead, baselineBaseHead(repo, key));
    fs.writeFileSync(path.join(repo, "README.md"), "operator-two\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-q", "-m", "operator commit"]);
    const newHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const moved = headMovedSinceBaseline(repo, key);
    check("baseline: HEAD-moved check reports the drift",
      newHead !== firstHead && moved.moved === true && moved.baseHead === firstHead && moved.head === newHead, moved);
    const rebased = rebaseBaselineOntoHead(repo, key);
    check("rebase: reports the operator-committed file", rebased.ok && rebased.rebased && rebased.files.includes("README.md"), rebased);
    check("rebase: manifest moves to the new HEAD", baselineBaseHead(repo, key) === newHead, baselineBaseHead(repo, key));
    check("rebase: operator commit leaves the phase delta", scopedDelta(repo, key).trim() === "", scopedDelta(repo, key));
    check("rebase: baseline directory backed up first", Boolean(rebased.backup) && fs.existsSync(path.join(repo, rebased.backup)), rebased.backup);
    check("rebase: second call is a no-op", rebaseBaselineOntoHead(repo, key).reason === "already-at-head");
  }

  // ---- #40 c: rebase --note persists for the next briefs ------------------
  {
    const repo = track(makeFixtureRepo("b2-note-"));
    writeConfig(repo, {planningFramework: "standalone"});
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1, phase: "implementing", step: "implementer", phaseIndex: 0, taskIndex: 0, attempt: 0, mission: "b2-note",
    }, null, 2));
    const r = cli(repo, ["rebase", "--note", "operator committed during the pause", "--yes"]);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("rebase --note: command exits 0", r.status === 0, `${r.stdout}${r.stderr}`.slice(-600));
    check("rebase --note: note stored with its phase",
      state.operatorPhaseNote?.text === "operator committed during the pause" && state.operatorPhaseNote?.phaseIndex === 0,
      state.operatorPhaseNote);
    const source = fs.readFileSync(autopilot, "utf8");
    check("rebase --note: implementer + reviewer briefs render the note",
      (source.match(/operatorPhaseNoteLine\(s\)/g) || []).length >= 4
      && source.includes("Operator note: ${n.text.trim()}"), "operatorPhaseNoteLine call sites");
  }

  // ---- #40 d: finding list/drop removes everywhere -----------------------
  {
    const repo = track(makeFixtureRepo("b2-finding-"));
    writeConfig(repo, {planningFramework: "standalone"});
    const statePath = path.join(repo, ".autopilot", "state.json");
    const state = {
      version: 1, phase: "implementing", step: "implementer", phaseIndex: 0, attempt: 1, mission: "b2-finding",
      reviewFeedback: {"standalone-phase:0": {findings: ["keep me", "drop me"], at: new Date().toISOString()}},
      codeReviewHistory: {"standalone-phase:0": [{round: 1, findings: ["keep me", "drop me"], previous: [{finding: "drop me", status: "not_fixed"}]}]},
      verifierHistory: {"standalone-phase:0": [{round: 1, findings: ["drop me"], previous: []}]},
      reviewFindingTasks: {"standalone-phase:0": {entries: [{source: "file", taskIds: ["t1"]}, {source: "file", taskIds: ["t2"]}]}},
      feedback: "1. keep me\n2. drop me",
      lastFailure: {evidence: [{finding: "drop me"}]},
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    const listed = cli(repo, ["finding", "list"]);
    check("finding list: numbers the current findings", listed.status === 0
      && listed.stdout.includes("1. keep me") && listed.stdout.includes("2. drop me"), `${listed.stdout}${listed.stderr}`);
    const r = cli(repo, ["finding", "drop", "2", "--note", "operator code", "--yes"]);
    const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
    check("finding drop: command exits 0", r.status === 0, `${r.stdout}${r.stderr}`.slice(-600));
    check("finding drop: review feedback keeps the other finding",
      JSON.stringify(after.reviewFeedback?.["standalone-phase:0"]?.findings) === JSON.stringify(["keep me"]), after.reviewFeedback);
    check("finding drop: code review history cleaned",
      JSON.stringify(after.codeReviewHistory?.["standalone-phase:0"]?.[0]?.findings) === JSON.stringify(["keep me"])
      && (after.codeReviewHistory?.["standalone-phase:0"]?.[0]?.previous || []).length === 0, after.codeReviewHistory);
    check("finding drop: verifier history cleaned",
      (after.verifierHistory?.["standalone-phase:0"]?.[0]?.findings || []).length === 0, after.verifierHistory);
    check("finding drop: legacy feedback line cleaned", after.feedback === "1. keep me", after.feedback);
    check("finding drop: last-failure evidence cleaned",
      (after.lastFailure?.evidence || []).length === 0, after.lastFailure);
    check("finding drop: finding-task entry stays aligned",
      after.reviewFindingTasks?.["standalone-phase:0"]?.entries?.length === 1
      && after.reviewFindingTasks["standalone-phase:0"].entries[0].taskIds[0] === "t1",
      after.reviewFindingTasks);
    check("finding drop: audit record written",
      after.operatorDroppedFindings?.at(-1)?.finding === "drop me"
      && after.operatorDroppedFindings.at(-1)?.note === "operator code", after.operatorDroppedFindings);
  }

  // ---- #40 d: drop refuses while a run is live ---------------------------
  if (process.platform === "win32") {
    console.log("SKIP finding drop live-refuse on win32 (no /proc scan)");
  } else {
    const repo = track(makeFixtureRepo("b2-finding-live-"));
    writeConfig(repo, {planningFramework: "standalone"});
    const statePath = path.join(repo, ".autopilot", "state.json");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, phase: "implementing", step: "implementer", phaseIndex: 0, mission: "b2-live",
      reviewFeedback: {"standalone-phase:0": {findings: ["drop me"]}},
    }, null, 2));
    const before = fs.readFileSync(statePath, "utf8");
    const fakeDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "b2-live-")));
    fs.writeFileSync(path.join(fakeDir, "autopilot.mjs"), "setInterval(() => {}, 1000);\n");
    const live = spawn(process.execPath, [path.join(fakeDir, "autopilot.mjs"), "run", "--repo", repo],
      {cwd: repo, env: cleanEnv, stdio: "ignore", shell: false});
    try {
      const deadline = Date.now() + 10000;
      let visible = false;
      while (Date.now() < deadline) {
        try {
          const cmd = fs.readFileSync(`/proc/${live.pid}/cmdline`, "utf8");
          if (cmd.includes("autopilot.mjs") && /(?:^|\0)run(?:\0|$)/.test(cmd)) { visible = true; break; }
        } catch { /* not yet */ }
        if (live.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      check("finding drop: live-run precondition", visible, live.exitCode);
      if (visible) {
        const r = cli(repo, ["finding", "drop", "1", "--yes"]);
        check("finding drop: refuses while live", r.status !== 0 && /refusing to edit findings while a run is live/.test(`${r.stdout}${r.stderr}`), r.status);
        check("finding drop: live refusal leaves state untouched", fs.readFileSync(statePath, "utf8") === before);
      }
    } finally {
      try { live.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  // ---- #41 escalation threshold 1 / 2 / 3 --------------------------------
  {
    const config = {roles: {implementer: {escalation_model: {adapter: "opencode", model: "strong"}}}};
    const previous = [{finding: "same bug", status: "not_fixed"}];
    const round = (prev) => ({findings: ["same bug"], previous: prev});
    const history1 = [round([]), round(previous)];
    check("escalation: one report has streak 1", consecutiveNotFixedReports(previous, history1, "same bug") === 1);
    const one = scheduleEscalation({}, config, {role: "implementer", scopeKey: "s", source: "code_reviewer", previous, history: history1, round: 2, minConsecutiveNotFixed: 1});
    check("escalation: threshold 1 triggers on the first not_fixed report", Boolean(one?.to), one);
    const twoShort = scheduleEscalation({}, config, {role: "implementer", scopeKey: "s", source: "code_reviewer", previous, history: history1, round: 2, minConsecutiveNotFixed: 2});
    check("escalation: threshold 2 waits after one report", twoShort === null, twoShort);
    const history2 = [round([]), round(previous), round(previous)];
    check("escalation: two consecutive reports have streak 2", consecutiveNotFixedReports(previous, history2, "same bug") === 2);
    const two = scheduleEscalation({}, config, {role: "implementer", scopeKey: "s", source: "code_reviewer", previous, history: history2, round: 3, minConsecutiveNotFixed: 2});
    check("escalation: threshold 2 triggers on the second consecutive report", Boolean(two?.to), two);
    const threeShort = scheduleEscalation({}, config, {role: "implementer", scopeKey: "s", source: "code_reviewer", previous, history: history2, round: 3, minConsecutiveNotFixed: 3});
    check("escalation: threshold 3 waits after two reports", threeShort === null, threeShort);
    const history3 = [round([]), round(previous), round(previous), round(previous)];
    const three = scheduleEscalation({}, config, {role: "implementer", scopeKey: "s3", source: "code_reviewer", previous, history: history3, round: 4, minConsecutiveNotFixed: 3});
    check("escalation: threshold 3 triggers on the third consecutive report", Boolean(three?.to), three);
  }

  // ---- #41 setting in layout, validation, schema -------------------------
  {
    check("setting: default is 2", DEFAULTS.retries.escalate_after_not_fixed === 2, DEFAULTS.retries);
    const bad = validateNewConfig({...DEFAULTS, retries: {...DEFAULTS.retries, escalate_after_not_fixed: 0}});
    check("setting: validation rejects below 1", bad.valid === false
      && bad.errors.some((e) => e.includes("escalate_after_not_fixed")), bad.errors);
    const good = validateNewConfig({...DEFAULTS, retries: {...DEFAULTS.retries, escalate_after_not_fixed: 3}});
    check("setting: validation accepts 3", good.valid === true, good.errors);
    const schema = JSON.parse(fs.readFileSync(path.join(here, "..", "config.schema.json"), "utf8"));
    check("setting: schema documents the retries key",
      schema.properties?.retries?.properties?.escalate_after_not_fixed?.minimum === 1
      && schema.properties?.retries?.properties?.escalate_after_not_fixed?.default === 2,
      schema.properties?.retries?.properties?.escalate_after_not_fixed);
  }

  // ---- #42 a: silent opencode nonzero -> RATE_LIMITED --------------------
  {
    const silent = classifyObservedFailure({exitCode: 1, stderr: "", stdout: ""});
    check("failure: silent nonzero starts as PROCESS_EXIT_NONZERO", silent.class === "PROCESS_EXIT_NONZERO", silent);
    check("failure: opencode silent nonzero reclassified RATE_LIMITED",
      reclassifySilentOpenCodeFailure(silent, {adapter: "opencode", output: "", stderr: ""}).class === "RATE_LIMITED");
    check("failure: opencode stderr 429 reclassified RATE_LIMITED",
      reclassifySilentOpenCodeFailure(silent, {adapter: "opencode", output: "partial", stderr: "Error: 429 Too Many Requests"}).class === "RATE_LIMITED");
    check("failure: non-opencode silent nonzero stays PROCESS_EXIT_NONZERO",
      reclassifySilentOpenCodeFailure(silent, {adapter: "claude", output: "", stderr: ""}).class === "PROCESS_EXIT_NONZERO");
    check("failure: opencode crash with output stays PROCESS_EXIT_NONZERO",
      reclassifySilentOpenCodeFailure(silent, {adapter: "opencode", output: "TypeError: boom", stderr: ""}).class === "PROCESS_EXIT_NONZERO");
    const crash = classifyObservedFailure({exitCode: 1, stderr: "SyntaxError: bad config", stdout: "stack trace"});
    check("failure: ordinary crash with output keeps its class",
      reclassifySilentOpenCodeFailure(crash, {adapter: "opencode", output: "stack trace", stderr: "SyntaxError: bad config"}).class === "PROCESS_EXIT_NONZERO");
  }

  // ---- #42 b: primary change beats a sticky fallback ---------------------
  {
    const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
    const roleConfig = {adapter: "opencode", model: "new-primary"};
    const current = staleStickyFallback({role: "implementer", roleConfig,
      activeModel: {adapter: "opencode", model: "fallback", derivedFrom: {adapter: "opencode", model: "old-primary"}, since: "2026-10-20T10:00:00.000Z"},
      nowMs});
    check("sticky: config primary change clears the fallback", current?.why === "config", current);
    const legacy = staleStickyFallback({role: "implementer", roleConfig,
      activeModel: {adapter: "opencode", model: "fallback", since: "2026-10-20T10:00:00.000Z"},
      nowMs, configMtimeMs: Date.parse("2026-10-20T11:00:00.000Z")});
    check("sticky: legacy entry cleared when config changed after selection", legacy?.why === "config", legacy);
    const unchanged = staleStickyFallback({role: "implementer", roleConfig,
      activeModel: {adapter: "opencode", model: "fallback", since: "2026-10-20T10:00:00.000Z"},
      nowMs: Date.parse("2026-10-20T10:30:00.000Z"), configMtimeMs: Date.parse("2026-10-20T09:00:00.000Z")});
    check("sticky: legacy entry kept when config predates selection", unchanged === null, unchanged);
    const map = markExhausted({}, {adapter: "opencode", model: "beam-free"}, "implementer", "2026-10-20T12:00:00.000Z");
    check("sticky: exhausted key is canonical (no opencode/opencode)", Object.keys(map).join(",") === "opencode/beam-free", Object.keys(map));
    check("sticky: canonical key matches the same model",
      isExhausted(map, {adapter: "opencode", model: "opencode/beam-free"}, {}, nowMs));
  }
} finally {
  for (const dir of made) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best effort */ }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
