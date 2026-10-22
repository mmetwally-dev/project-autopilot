#!/usr/bin/env node
// Backlog #11 (first half): bare `ap reset` is the GLOBAL form; `--scope` stays single-key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {makeFixtureRepo, writeConfig, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, ok, detail){
  if (ok) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}
const repos = [];
function makeRepo(state){
  const repo = makeFixtureRepo("reset-global");
  writeConfig(repo, {planningFramework: "standalone"});
  repos.push(repo);
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
  return repo;
}
const readState = repo => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
function run(args, repo){
  const r = spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), ...args, "--repo", repo], {encoding: "utf8"});
  return {status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`};
}
const CONT = "continuationAllowance:task:standalone:phase-1:T9";
const spent = () => ({
  version: 1, phase: "escalated", step: "standalone-plan", phaseIndex: 3, taskIndex: 2, attempt: 1,
  mission: "999-test-mission", missionSeq: "999",
  checkpoint: {type: "standalone-phase", phase: "Phase 4", index: 3},
  failureBudgets: {"infrastructureRetryBudget:mission": 2, "adapterRetryBudget:adapter:opencode:verifier": 1, "implementationFailureBudget:task:T1": 3},
  lastFailureBudget: {allowed: false, budget: "infrastructureRetryBudget", used: 2, limit: 2, scope: "mission"},
  continuationBudgets: {[CONT]: 4},
  rolloverDeadEnds: {[CONT]: ["a", "b"]},
  standalonePlanReview: {revision: 10, reviewFeedback: ["keep me"], findings: [{id: 1}]},
  reviewFeedback: {k: ["f"]}
});

{
  const repo = makeRepo(spent());
  const r = run(["reset"], repo);
  const s = readState(repo);
  check("bare reset exits 0", r.status === 0, r);
  check("every failure key cleared", Object.keys(s.failureBudgets || {}).length === 0, s.failureBudgets);
  check("continuation + dead-ends cleared", !Object.keys(s.continuationBudgets || {}).length && !Object.keys(s.rolloverDeadEnds || {}).length, s);
  check("plan revision counter cleared", s.standalonePlanReview && s.standalonePlanReview.revision === undefined, s.standalonePlanReview);
  check("reviewFeedback and findings kept", JSON.stringify(s.standalonePlanReview.reviewFeedback) === '["keep me"]' && s.standalonePlanReview.findings.length === 1 && s.reviewFeedback?.k?.[0] === "f", s);
  check("stage position and checkpoint kept", s.phaseIndex === 3 && s.taskIndex === 2 && s.step === "standalone-plan" && s.checkpoint.index === 3, s);
  check("output lists each cleared key and the resume hint",
    ["infrastructureRetryBudget:mission", "adapterRetryBudget:adapter:opencode:verifier", "implementationFailureBudget:task:T1", CONT, "standalonePlanReview.revision"].every(k => r.out.includes(k))
    && r.out.includes("`ap run` (no message) now resumes"), r.out);
  const again = run(["reset"], repo);
  check("nothing spent -> non-zero with --scope hint", again.status !== 0 && again.out.includes("--scope"), again);
}
{
  const repo = makeRepo(spent());
  const r = run(["reset", "--scope", "infrastructureRetryBudget:mission"], repo);
  const s = readState(repo);
  check("--scope clears exactly that failure key", r.status === 0 && !("infrastructureRetryBudget:mission" in s.failureBudgets)
    && Object.keys(s.failureBudgets).length === 2 && s.continuationBudgets[CONT] === 4 && s.standalonePlanReview.revision === 10, s);
  const c = run(["reset", "--scope", CONT], repo);
  const s2 = readState(repo);
  check("--scope <continuation> clears only the continuation", c.status === 0 && !s2.continuationBudgets[CONT]
    && Object.keys(s2.failureBudgets).length === 2 && s2.standalonePlanReview.revision === 10, s2);
}
{
  const st = spent(); st.failureBudgets = {}; st.continuationBudgets = {}; st.rolloverDeadEnds = {}; st.standalonePlanReview = {reviewFeedback: ["x"]};
  const repo = makeRepo(st);
  const r = run(["reset"], repo);
  check("empty state: non-zero", r.status !== 0 && r.out.includes("--scope"), r);
}
{
  const st = spent(); st.failureBudgets = {}; st.continuationBudgets = {}; st.rolloverDeadEnds = {};
  const repo = makeRepo(st);
  const r = run(["reset"], repo);
  check("only a plan revision spent: bare reset clears it", r.status === 0 && readState(repo).standalonePlanReview.revision === undefined, r);
}
for (const r of repos) cleanup(r);
if (failures) { console.error(`${failures} reset-global check(s) failed.`); process.exit(1); }
console.log("test-reset-global: ALL CHECKS PASSED");
