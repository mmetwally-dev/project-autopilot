#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitPhaseFixture, writeConfig,
  setScenario, runAutopilot, readObservedEvents, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {noteSaysRevisionDone} from "./per-task-budget.mjs";
import {normalizeRel} from "./planning-boundary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_FILE = path.join(here, "test-fixtures", "fake-capped-revision-adapter.mjs");
const AUTOPILOT_FILE = path.join(here, "autopilot.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function installFakeAdapter(binDir, {revisionNote = null, staleNote = false} = {}) {
  const shimPath = path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  const wrapperCode = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("--help") || args[0] === "models") {
  const child = spawn(process.execPath, [${JSON.stringify(ADAPTER_FILE)}, ...args], {stdio: "inherit"});
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  let stdinText = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { stdinText += c; });
  process.stdin.on("end", () => {
    const prompt = stdinText + " " + args.join(" ");
    const isRevision = (
      (prompt.includes("Planning phase: tasks") && prompt.includes("The plan reviewer REJECTED") && !prompt.includes("Prior dead ends")) ||
      (prompt.includes("Create or continue an implementation plan") && (prompt.includes("This is a REVISION round") || prompt.includes("Plan reviewer feedback that MUST be addressed")) && !prompt.includes("Prior dead ends"))
    );
    const noteContent = ${JSON.stringify(revisionNote)};
    const writeNote = () => {
      if (isRevision && noteContent !== null) {
        const m = /Keep a hand-off note at (\\S+)/.exec(prompt);
        if (m) {
          const noteRel = m[1].replace(/[.,;:]+$/, "");
          fs.mkdirSync(path.dirname(noteRel), {recursive: true});
          fs.writeFileSync(noteRel, noteContent, "utf8");
          if (${JSON.stringify(staleNote)}) {
            const past = new Date(Date.now() - 60_000);
            fs.utimesSync(noteRel, past, past);
          }
        }
      }
    };
    const child = spawn(process.execPath, [${JSON.stringify(ADAPTER_FILE)}, ...args], {stdio: ["pipe", "pipe", "inherit"]});
    child.stdout.once("data", writeNote);
    child.stdout.pipe(process.stdout);
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, () => { try { child.kill(sig); } catch {} });
    }
    child.stdin.write(stdinText);
    child.stdin.end();
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
  });
}
`;
  if (process.platform === "win32") {
    const fixtureCopy = path.join(binDir, "fake-adapter.mjs");
    fs.writeFileSync(fixtureCopy, wrapperCode);
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${fixtureCopy}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    fs.writeFileSync(shimPath, wrapperCode);
    fs.chmodSync(shimPath, 0o755);

    // Provide a bwrap shim so read-only reviewer envelope tests can run inside sandboxed test runners
    const bwrapShim = path.join(binDir, "bwrap");
    fs.writeFileSync(bwrapShim, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bubblewrap 0.8.0"
  exit 0
fi
HOST_BIN=""
SANDBOX_BIN=""
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "--ro-bind" ]; then
    shift
    if [ -f "$1" ]; then
      HOST_BIN="$1"
      shift
      SANDBOX_BIN="$1"
    fi
  fi
  shift
done
if [ "$1" = "--" ]; then
  shift
fi
CMD="$1"
shift
if [ -n "$HOST_BIN" ] && [ "$CMD" = "$SANDBOX_BIN" ]; then
  CMD="$HOST_BIN"
fi
exec "$CMD" "$@"
`);
    fs.chmodSync(bwrapShim, 0o755);
  }
}

const FRESH_DONE_NOTE = [
  "# Handoff Note",
  "1. Done — edited tasks.md",
  "2. Found — none",
  "3. Next — none — all cited findings addressed",
  "4. Dead ends — none",
].join("\n");

// ────────────────────────────────────────────────────────────────────────────
// Case 1: SpecKit tasks stage, review FAIL then planner revision capped after editing tasks.md
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c1");
  const binDir = makeFixtureBin("capped-rev-c1");
  try {
    installFakeAdapter(binDir, {revisionNote: FRESH_DONE_NOTE});
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case1_speckit_revision_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "speckit test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 1: planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status, planRevision: r.planRevision})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 1: next run is plan_reviewer (sent to review instead of continuation)", nextRun?.role === "plan_reviewer", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 1: no 'continuing as session' line in output", !out.includes("continuing as session"), out.slice(-400));

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const deadEnds = state.rolloverDeadEnds?.["continuationAllowance:task:speckit:planning:planner"] || [];
    const allowanceConsumed = state.continuationBudgets?.["continuationAllowance:task:speckit:planning:planner"] || 0;
    check("case 1: continuation allowance unchanged", allowanceConsumed === 0 && deadEnds.length === 0, {allowanceConsumed, deadEnds});

    check("case 1: logged expected line sending revision to review",
      out.includes("hit the turns cap after editing") && out.includes("; sending the revision to review instead of another session."),
      out.slice(-500));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 2: Same as Case 1, but planner edited nothing
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c2");
  const binDir = makeFixtureBin("capped-rev-c2");
  try {
    installFakeAdapter(binDir);
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case2_speckit_revision_capped_no_edit");

    const result = runAutopilot(repo, binDir, {request: "speckit test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 2: planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status, planRevision: r.planRevision})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 2: next run is planner (existing continuation behaviour)", nextRun?.role === "planner", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 2: output includes 'continuing as session'", out.includes("continuing as session"), out.slice(-400));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 3: Standalone planning equivalent of Case 1
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c3");
  const binDir = makeFixtureBin("capped-rev-c3");
  try {
    installFakeAdapter(binDir, {revisionNote: FRESH_DONE_NOTE});
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case3_standalone_revision_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "standalone test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 3: standalone planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status, planRevision: r.planRevision})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 3: next run is plan_reviewer (sent to review instead of continuation)", nextRun?.role === "plan_reviewer", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 3: no 'continuing as session' line in output", !out.includes("continuing as session"), out.slice(-400));

    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const deadEnds = state.rolloverDeadEnds?.["continuationAllowance:task:standalone:planning:planner"] || [];
    const allowanceConsumed = state.continuationBudgets?.["continuationAllowance:task:standalone:planning:planner"] || 0;
    check("case 3: continuation allowance unchanged", allowanceConsumed === 0 && deadEnds.length === 0, {allowanceConsumed, deadEnds});

    check("case 3: logged expected line sending revision to review",
      out.includes("hit the turns cap after editing") && out.includes("; sending the revision to review instead of another session."),
      out.slice(-500));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 4: First-attempt planner capped after editing → existing continuation
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c4");
  const binDir = makeFixtureBin("capped-rev-c4");
  try {
    installFakeAdapter(binDir, {revisionNote: FRESH_DONE_NOTE});
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case4_first_attempt_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "standalone test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));

    const cappedPlannerIdx = runs.findIndex(r => r.role === "planner" && r.status === "capped");
    check("case 4: first-attempt planner was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 4: next run is planner (existing continuation, not sent to review)", nextRun?.role === "planner", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 4: output includes 'continuing as session'", out.includes("continuing as session"), out.slice(-400));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Case 5 (e2e): SpecKit revision capped after editing tasks.md, NO hand-off note → continues planner
// ────────────────────────────────────────────────────────────────────────────
{
  const repo = makeFixtureRepo("capped-rev-c5");
  const binDir = makeFixtureBin("capped-rev-c5");
  try {
    installFakeAdapter(binDir, {revisionNote: null});
    makeSpecKitPhaseFixture(repo);
    writeConfig(repo, {planningFramework: "speckit", maxPlanRevisions: 2, networkIsolation: false});
    const configPath = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.roles.planner.adapter = "opencode";
    config.roles.plan_reviewer.adapter = "opencode";
    config.workflow.implementationReview = false;
    config.workflow.finalReview = false;
    config.policy = {
      ...config.policy,
      per_task_max_turns: 3,
      per_task_max_tokens: 10_000_000,
      per_task_timeout_ms: 60_000,
      continuation_allowance: 2,
      no_progress_generations: 5,
      caps: {
        planner: { max_turns: 3, extra_sessions: 2 },
        plan_reviewer: { max_turns: 3, extra_sessions: 2 },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    setScenario(repo, "case1_speckit_revision_capped_with_edit");

    const result = runAutopilot(repo, binDir, {request: "speckit test", stage: "planning", timeoutMs: 60_000});
    const runs = readObservedEvents(repo).map(e => ({role: e.role, status: e.status, ...JSON.parse(fs.readFileSync(e.file, "utf8"))}));
    const cappedPlannerIdx = runs.findIndex((r, idx) => r.role === "planner" && r.status === "capped" && runs.slice(0, idx).some(pr => pr.role === "plan_reviewer" && (pr.verdict?.decision === "FAIL" || pr.decision === "FAIL")));
    check("case 5 (e2e no note): planner revision was capped", cappedPlannerIdx !== -1, runs.map(r => ({role: r.role, status: r.status})));

    const nextRun = runs[cappedPlannerIdx + 1];
    check("case 5 (e2e no note): next run is planner (continues instead of sending to review)", nextRun?.role === "planner", nextRun?.role);

    const out = `${result.stdout}\n${result.stderr}`;
    check("case 5 (e2e no note): logs continuing-planner message",
      out.includes("continuing the planner instead of sending an unfinished revision to review"),
      out.slice(-500));
  } finally {
    cleanup(repo, binDir);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Unit checks: noteSaysRevisionDone, acceptCappedPlannerRevision (a)-(f), and source scan
// ────────────────────────────────────────────────────────────────────────────
{
  const autopilotSource = fs.readFileSync(AUTOPILOT_FILE, "utf8");
  const fnMatch = autopilotSource.match(/function acceptCappedPlannerRevision\([\s\S]*?\n\}/);
  check("source: acceptCappedPlannerRevision function found", Boolean(fnMatch));

  const callMatches = [...autopilotSource.matchAll(/(?<!function\s)acceptCappedPlannerRevision\(\{[\s\S]*?\}\)/g)];
  check("source: all 3 acceptCappedPlannerRevision call sites found", callMatches.length === 3, callMatches.length);
  for (let i = 0; i < callMatches.length; i++) {
    const body = callMatches[i][0];
    check(`source: call site ${i + 1} passes noteText and noteFresh`,
      body.includes("noteText") && body.includes("noteFresh"),
      body);
  }

  const makeAccept = () => {
    const logs = [];
    const fakeConsole = { log: (...a) => logs.push(a.join(" ")) };
    const fn = new Function(
      "normalizeRel", "path", "noteSaysRevisionDone", "console",
      `${fnMatch[0]}; return acceptCappedPlannerRevision;`
    )(normalizeRel, path, noteSaysRevisionDone, fakeConsole);
    return { fn, logs };
  };

  const baseArgs = () => ({
    subject: "SpecKit planner spec",
    result: { capped: { type: "turns", used: 3, limit: 3 } },
    touchedFiles: ["specs/001-feat/spec.md"],
    isRevision: true,
    candidateArtifacts: ["specs/001-feat/spec.md", "spec.md"],
  });

  // (a) NO note -> null + log
  {
    const { fn, logs } = makeAccept();
    const res = fn({ ...baseArgs(), noteText: "", noteFresh: false });
    check("(a) capped revision with no note returns null", res === null, res);
    check("(a) logs continuing-planner line",
      logs.some(l => l.includes("continuing the planner instead of sending an unfinished revision to review")),
      logs);
  }

  // (b) fresh note whose Next lists remaining work -> null
  {
    const { fn, logs } = makeAccept();
    const note = "# Handoff Note\n1. Done — partial\n3. Next — FR-061 in spec.md still needs the 403 wording";
    const res = fn({ ...baseArgs(), noteText: note, noteFresh: true });
    check("(b) capped revision with unfinished Next returns null", res === null, res);
    check("(b) logs continuing-planner line",
      logs.some(l => l.includes("continuing the planner instead of sending an unfinished revision to review")),
      logs);
  }

  // (c) note says done, but noteFresh false -> null
  {
    const { fn, logs } = makeAccept();
    const res = fn({ ...baseArgs(), noteText: FRESH_DONE_NOTE, noteFresh: false });
    check("(c) capped revision with stale note (noteFresh=false) returns null", res === null, res);
    check("(c) logs continuing-planner line",
      logs.some(l => l.includes("continuing the planner instead of sending an unfinished revision to review")),
      logs);
  }

  // (d) orchestrator fallback note -> null
  {
    const { fn, logs } = makeAccept();
    const fallbackNote = "# Handoff Note — x (orchestrator fallback — session stopped at turns cap)\n3. Next — none — all cited findings addressed";
    const res = fn({ ...baseArgs(), noteText: fallbackNote, noteFresh: true });
    check("(d) capped revision with orchestrator fallback note returns null", res === null, res);
    check("(d) logs continuing-planner line",
      logs.some(l => l.includes("continuing the planner instead of sending an unfinished revision to review")),
      logs);
  }

  // (e) fresh note Next "none — all cited findings addressed, ready for review" -> returns matched file
  {
    const { fn, logs } = makeAccept();
    const doneNote = "# Handoff Note\n1. Done — updated spec.md\n3. Next — none — all cited findings addressed, ready for review";
    const res = fn({ ...baseArgs(), noteText: doneNote, noteFresh: true });
    check("(e) capped revision with fresh done note returns matched file", res === "specs/001-feat/spec.md", res);
    check("(e) logs sending revision to review",
      logs.some(l => l.includes("sending the revision to review instead of another session.")),
      logs);
  }

  // (f) unit checks of noteSaysRevisionDone
  check("(f) noteSaysRevisionDone('') === false", noteSaysRevisionDone("") === false);
  check("(f) noteSaysRevisionDone(null) === false", noteSaysRevisionDone(null) === false);
  check("(f) noteSaysRevisionDone(fallback) === false",
    noteSaysRevisionDone("# Handoff Note — x (orchestrator fallback)\nNext: none — all cited findings addressed") === false);
  check("(f) noteSaysRevisionDone(unfinished Next) === false",
    noteSaysRevisionDone("# Handoff Note\n3. Next — FR-061 in spec.md still needs the 403 wording") === false);
  check("(f) noteSaysRevisionDone(file ref in Next) === false",
    noteSaysRevisionDone("# Handoff Note\n3. Next — ready for review after plan.md") === false);
  check("(f) noteSaysRevisionDone(TODO in Next) === false",
    noteSaysRevisionDone("# Handoff Note\n3. Next — none, TODO: fix auth") === false);
  check("(f) noteSaysRevisionDone(done) === true",
    noteSaysRevisionDone("# Handoff Note\n3. Next — none — all cited findings addressed, ready for review") === true);
  check("(f) noteSaysRevisionDone(all cited findings fixed) === true",
    noteSaysRevisionDone("# Handoff Note\n3. Next — all cited findings are fixed") === true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll capped-revision-to-review checks passed.");
