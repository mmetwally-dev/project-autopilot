#!/usr/bin/env node
// A plan-review PASS that came from a SCOPED re-review (the brief listed
// earlier findings to verify) is not accepted until one fresh FULL
// "confirmation" review also PASSes. Drives real `autopilot.mjs run`
// subprocesses with a fake plan_reviewer whose decisions are scripted per
// launch (".autopilot/.pr-script", one PASS/FAIL/HANG per line, committed so
// the read-only sandbox sees it). Everything else uses the shared fake
// workflow adapter. Observed evidence: the reviewer brief.txt and result.json
// the orchestrator writes for every plan_reviewer run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, setScenario, writeConfig, runAutopilot,
  runAutopilotUntilMarker, hangStarted, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import {fixtureGit} from "./test-fixtures/fixture-git.mjs";
import {PLAN_REVIEW_CONFIRMATION_LINE, PLAN_REVIEW_EXHAUSTIVE_LINE} from "./plan-review-rounds.mjs";

const PREVIOUS = "Previous findings from all earlier review rounds";
let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}
const readState = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}
// Completed runs of a role, chronological, with the brief the role received.
function runs(repo, role) {
  const out = [];
  for (const f of walk(path.join(repo, ".autopilot"))) {
    if (path.basename(f) !== "result.json") continue;
    let data; try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (data.role !== role) continue;
    const briefFile = path.join(path.dirname(f), "brief.txt");
    let note = null;
    try { note = JSON.parse(fs.readFileSync(path.join(path.dirname(f), "status.json"), "utf8")).note ?? null; } catch { note = null; }
    out.push({data, decision: data.verdict?.decision ?? null, startedAt: Date.parse(data.startedAt), note,
      brief: fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : ""});
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
const isConfirmation = (r) => r.data.planReviewConfirmation === true;

// The fake workflow adapter with a scripted plan_reviewer prepended (single
// file: the sandbox bind-mounts only the binary).
function installScriptedReviewer(binDir) {
  const target = path.join(binDir, "cursor-agent");
  const src = fs.readFileSync(target, "utf8");
  const anchor = src.indexOf("\nSCENARIO=\"success\"");
  if (anchor < 0) throw new Error("fake adapter layout changed");
  const prelude = `
if [ "$ROLE" = "plan_reviewer" ] && [ -f ./.autopilot/.pr-script ]; then
  _n=$(find ./.autopilot -name status.json -exec grep -l '"role": *"plan_reviewer"' {} + 2>/dev/null | wc -l)
  _act=$(sed -n "$_n"p ./.autopilot/.pr-script)
  case "$_act" in
    HANG) sleep 600 ;;
    FAIL) printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["gap-%s: scripted finding"]}\\n' "$_n" ;;
    *) printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\\n' ;;
  esac
  exit 0
fi`;
  fs.writeFileSync(target, src.slice(0, anchor) + prelude + src.slice(anchor));
}
function setScript(repo, lines) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", ".pr-script"), lines.join("\n") + "\n");
  fixtureGit(["add", "-f", ".autopilot/.pr-script"], {cwd: repo});
  fixtureGit(["commit", "-q", "-m", "reviewer script"], {cwd: repo});
}
const dirs = [];
function setup(prefix, framework, script, maxPlanRevisions = 4) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  dirs.push(repo, binDir);
  installScriptedReviewer(binDir);
  writeConfig(repo, {planningFramework: framework, maxPlanRevisions});
  if (framework === "speckit") makeSpecKitWorkflowOnly(repo);
  setScenario(repo, "success");
  setScript(repo, script);
  return {repo, binDir};
}
const plan = (repo, binDir, request = "fixture request") => runAutopilot(repo, binDir, {request, stage: "planning", timeoutMs: 240000});
const hasPrev = (r) => r.brief.includes(PREVIOUS);

try {
  // ---- standalone ----
  {
    // 1. FAIL -> scoped PASS -> confirmation full PASS -> tasks_ready.
    const {repo, binDir} = setup("sa1", "standalone", ["FAIL", "PASS", "PASS"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sa1 exits 0 and reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status, phase: st.phase, err: r.stderr.slice(-300)});
    check("sa1 three reviewer runs: full, scoped, confirmation", rv.length === 3, rv.length);
    check("sa1 round 1 is a full review (no previous findings)", rv[0] && !hasPrev(rv[0]) && !isConfirmation(rv[0]));
    check("sa1 round 2 is scoped (lists previous findings)", rv[1] && hasPrev(rv[1]) && !isConfirmation(rv[1]));
    check("sa1 confirmation brief has no previous findings and carries the confirmation line",
      rv[2] && !hasPrev(rv[2]) && !rv[2].brief.includes("Prior findings to re-check") && rv[2].brief.includes(PLAN_REVIEW_CONFIRMATION_LINE), rv[2]?.brief.slice(-400));
    check("sa1 only the third run is recorded as the confirmation", rv.map(isConfirmation).join() === "false,false,true", rv.map(isConfirmation));
    check("sa1 confirmation run note is the short full re-check", rv[2]?.note === "full re-check", rv[2]?.note);
    check("sa1 no planner ran for the confirmation", runs(repo, "planner").length === 2, runs(repo, "planner").length);
    check("sa1 review state cleaned on accept", !st.planReviewConfirmation && !st.planReviewHistory && !st.standalonePlanReview && !st.standalonePlanningReviewCheckpoint, {c: st.planReviewConfirmation, h: !!st.planReviewHistory});
  }
  {
    // 2. FAIL -> scoped PASS -> confirmation FAIL -> revision -> scoped PASS -> confirmation PASS.
    const {repo, binDir} = setup("sa2", "standalone", ["FAIL", "PASS", "FAIL", "PASS", "PASS"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sa2 exits 0 and reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status, err: r.stderr.slice(-300)});
    check("sa2 five reviewer runs", rv.length === 5, rv.length);
    check("sa2 confirmation runs are #3 and #5 only", rv.map(isConfirmation).join() === "false,false,true,false,true", rv.map(isConfirmation));
    check("sa2 the scoped re-review after the confirmation FAIL lists the confirmation findings",
      rv[3] && hasPrev(rv[3]) && rv[3].brief.includes("gap-3"), rv[3]?.brief.slice(-500));
    check("sa2 both confirmations are fresh full briefs", !hasPrev(rv[2]) && !hasPrev(rv[4]));
    check("sa2 a planner revision ran after the confirmation FAIL (1 + 2 planner runs)", runs(repo, "planner").length === 3, runs(repo, "planner").length);
  }
  {
    // 3. First full review PASS -> accepted, no confirmation round.
    const {repo, binDir} = setup("sa3", "standalone", ["PASS", "FAIL"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sa3 exits 0 at tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status});
    check("sa3 exactly one reviewer run, not a confirmation", rv.length === 1 && !isConfirmation(rv[0]) && !hasPrev(rv[0]), rv.length);
    check("sa3 first review is the exhaustive full brief", rv[0]?.brief.includes(PLAN_REVIEW_EXHAUSTIVE_LINE));
  }
  {
    // 4. Kill during the confirmation round: resume re-runs the confirmation.
    const {repo, binDir} = setup("sa4", "standalone", ["FAIL", "PASS", "HANG", "PASS"]);
    const k = await runAutopilotUntilMarker(repo, binDir, {
      request: "fixture request", markerFile: path.join(repo, ".never-marker"),
      readyWhen: () => hangStarted(repo, "plan_reviewer", 3), timeoutMs: 240000,
    });
    check("sa4 run 1 killed during the third (confirmation) review", k.readyObserved === true && k.killed === true && k.terminationConfirmed === true, {ready: k.readyObserved, killed: k.killed});
    const mid = readState(repo);
    check("sa4 persisted marker says the confirmation is pending", mid.planReviewConfirmation?.["standalone-plan"] === true, mid.planReviewConfirmation);
    check("sa4 planning is not accepted after the kill", mid.phase !== "tasks_ready", mid.phase);
    const plannersBefore = runs(repo, "planner").length;
    const r = plan(repo, binDir, "");
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sa4 resume finishes at tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status, err: r.stderr.slice(-300), out: r.stdout.slice(-300)});
    check("sa4 resume re-ran a reviewer as a confirmation full review", rv.length === 3 && isConfirmation(rv[2]) && !hasPrev(rv[2]), rv.map(isConfirmation));
    check("sa4 resume did not re-run the planner", runs(repo, "planner").length === plannersBefore, {before: plannersBefore});
    check("sa4 marker cleared after the accepted confirmation", !readState(repo).planReviewConfirmation);
  }
  {
    // 5a. A confirmation PASS consumes no revision: budget 2 is enough for FAIL (1) + PASS + PASS.
    const a = setup("sa5a", "standalone", ["FAIL", "PASS", "PASS"], 2);
    const ra = plan(a.repo, a.binDir);
    check("sa5a budget 2: one FAIL revision + scoped PASS + confirmation PASS succeeds", ra.status === 0 && readState(a.repo).phase === "tasks_ready", {status: ra.status, err: ra.stderr.slice(-200)});
    // 5b. A confirmation FAIL consumes a revision like any FAIL: budget 2 is then spent.
    const b = setup("sa5b", "standalone", ["FAIL", "PASS", "FAIL"], 2);
    const rb = plan(b.repo, b.binDir);
    const stb = readState(b.repo);
    check("sa5b budget 2: confirmation FAIL spends the second revision and escalates", rb.status !== 0 && /failed review after 2 revision/.test(rb.stdout + rb.stderr), {status: rb.status});
    check("sa5b revision count is 2 and the plan was not accepted", stb.standalonePlanReview?.revision === 2 && stb.phase !== "tasks_ready", {rev: stb.standalonePlanReview?.revision, phase: stb.phase});
    check("sa5b exactly one planner revision ran before the escalation (1 + 1)", runs(b.repo, "planner").length === 2, runs(b.repo, "planner").length);
    // 5c. Budget 3: confirmation FAIL leads to a second revision, then success.
    const c = setup("sa5c", "standalone", ["FAIL", "PASS", "FAIL", "PASS", "PASS"], 3);
    const rc = plan(c.repo, c.binDir);
    check("sa5c budget 3: two revisions (one from a confirmation FAIL) succeed", rc.status === 0 && readState(c.repo).phase === "tasks_ready", {status: rc.status, err: rc.stderr.slice(-200)});
  }

  // ---- SpecKit (gates review-spec, review-plan, review-tasks share the script;
  // the spec gate PASSes first so the revised gate is review-plan) ----
  {
    // K1. plan gate: FAIL -> revision -> scoped PASS -> confirmation PASS; other gates PASS first time.
    const {repo, binDir} = setup("sk1", "speckit", ["PASS", "FAIL", "PASS", "PASS", "PASS"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sk1 exits 0 and reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status, err: r.stderr.slice(-300), out: r.stdout.slice(-300)});
    check("sk1 five reviewer runs (spec; plan: full, scoped, confirmation; tasks)", rv.length === 5, rv.length);
    check("sk1 only the fourth run is a confirmation", rv.map(isConfirmation).join() === "false,false,false,true,false", rv.map(isConfirmation));
    check("sk1 confirmation run note is the short full re-check", rv[3]?.note === "full re-check", rv[3]?.note);
    check("sk1 initial review has no previous findings, re-review lists them", rv[1] && rv[2] && !hasPrev(rv[1]) && hasPrev(rv[2]));
    check("sk1 confirmation brief is a fresh full review without previous findings", rv[3] && !hasPrev(rv[3]) && rv[3].brief.includes(PLAN_REVIEW_CONFIRMATION_LINE) && rv[3].brief.includes("review-plan"), rv[3]?.brief.slice(-400));
    check("sk1 first-time PASS of the spec and tasks gates needs no confirmation", rv[0] && rv[4] && !hasPrev(rv[0]) && !hasPrev(rv[4]));
    check("sk1 review state cleaned", !st.planReviewConfirmation && !st.planReviewRevisions && !st.planReviewHistory, {c: st.planReviewConfirmation, r: st.planReviewRevisions});
  }
  {
    // K2. confirmation FAIL -> second revision -> scoped PASS -> confirmation PASS.
    const {repo, binDir} = setup("sk2", "speckit", ["PASS", "FAIL", "PASS", "FAIL", "PASS", "PASS", "PASS"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sk2 exits 0 and reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status, err: r.stderr.slice(-300), out: r.stdout.slice(-300)});
    check("sk2 seven reviewer runs", rv.length === 7, rv.length);
    check("sk2 confirmations are runs #4 and #6", rv.map(isConfirmation).join() === "false,false,false,true,false,true,false", rv.map(isConfirmation));
    check("sk2 re-review after the confirmation FAIL lists its findings", rv[4] && hasPrev(rv[4]) && rv[4].brief.includes("gap-4"));
    check("sk2 two planner revisions ran (3 stage planners + 2)", runs(repo, "planner").length === 5, runs(repo, "planner").length);
  }
  {
    // K3. first review PASS -> accepted, no confirmation at any gate.
    const {repo, binDir} = setup("sk3", "speckit", ["PASS", "PASS", "PASS"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    check("sk3 three first-time PASSes accepted without confirmation", r.status === 0 && rv.length === 3 && !rv.some(isConfirmation), {status: r.status, n: rv.length});
  }
  {
    // K4. budget 1: a confirmation FAIL with the revision budget spent escalates.
    const {repo, binDir} = setup("sk4", "speckit", ["PASS", "FAIL", "PASS", "FAIL"], 1);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sk4 budget 1: confirmation FAIL escalates instead of revising again", r.status !== 0 && rv.length === 4 && isConfirmation(rv[3]), {status: r.status, n: rv.length});
    check("sk4 only the one revision ran (specify + plan planners + 1; tasks stage never reached)", runs(repo, "planner").length === 3, runs(repo, "planner").length);
    check("sk4 the plan was not accepted", st.phase !== "tasks_ready", st.phase);
    // K5. budget 2 allows the second revision (the confirmation PASS consumes none).
    const b = setup("sk5", "speckit", ["PASS", "FAIL", "PASS", "FAIL", "PASS", "PASS", "PASS"], 2);
    const rb = plan(b.repo, b.binDir);
    check("sk5 budget 2: FAIL revision + confirmation-FAIL revision succeed", rb.status === 0 && readState(b.repo).phase === "tasks_ready", {status: rb.status, err: rb.stderr.slice(-200)});
  }
  {
    // K6. kill during the confirmation: resume re-runs the confirmation, never accepts.
    const {repo, binDir} = setup("sk6", "speckit", ["PASS", "FAIL", "PASS", "HANG", "PASS", "PASS"]);
    const k = await runAutopilotUntilMarker(repo, binDir, {
      request: "fixture request", markerFile: path.join(repo, ".never-marker"),
      readyWhen: () => hangStarted(repo, "plan_reviewer", 4), timeoutMs: 240000,
    });
    check("sk6 run 1 killed during the confirmation review", k.readyObserved === true && k.killed === true && k.terminationConfirmed === true, {ready: k.readyObserved, killed: k.killed});
    const mid = readState(repo);
    check("sk6 confirmation marker persisted for the plan gate", Object.values(mid.planReviewConfirmation || {}).includes(true), mid.planReviewConfirmation);
    const r = plan(repo, binDir, "");
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);
    check("sk6 resume reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", {status: r.status, err: r.stderr.slice(-300), out: r.stdout.slice(-300)});
    check("sk6 resume ran a confirmation full review (not an acceptance)", rv.length === 5 && isConfirmation(rv[3]) && !hasPrev(rv[3]), rv.map(isConfirmation));
  }
} finally {
  cleanup(...dirs);
}
process.exit(failures ? 1 : 0);
