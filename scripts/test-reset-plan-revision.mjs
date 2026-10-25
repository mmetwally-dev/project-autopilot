#!/usr/bin/env node
// Mission 086 Phase 1 tasks 1.1+1.2 — helper unit checks for
// scripts/reset-plan-revision.mjs plus CLI wiring checks for the
// `standalone-plan-revision` scope in scripts/autopilot.mjs.
// Pure unit sections use queue files under os.tmpdir(); CLI sections use
// fixture repos under $TMPDIR (os.tmpdir via makeFixtureRepo), never inside
// the project repo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  PLAN_REVISION_RESET_SCOPE, PLAN_REVISION_RESET_KEY,
  clearPlanRevisionCounter, planRevisionResetRequest,
  applyPendingPlanRevisionReset,
} from "./reset-plan-revision.mjs";
import {
  readResetRequests, enqueueResetRequest,
} from "./reset-request-queue.mjs";

let failures = 0;
function check(name, condition, detail){
  if(condition){ console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reset-plan-revision-"));
tempDirs.add(tmp);
const queueFile = () => path.join(tmp, `reset-${Math.random().toString(36).slice(2)}.json`);

function spentState(mission = "001-test-mission"){
  return {
    version: 1, mission, missionSeq: "001",
    failureBudgets: {"infrastructureRetryBudget:mission": 2},
    continuationBudgets: {"continuationAllowance:task:standalone:phase-1:T9": 4},
    rolloverDeadEnds: {"continuationAllowance:task:standalone:phase-1:T9": ["a"]},
    noProgressGenerations: {"continuationAllowance:task:standalone:phase-1:T9": 1},
    standalonePlanReview: {revision: 3, findings: [{id: "TASKS.md 2.3"}]},
    reviewFeedback: {"standalone-plan": [{finding: "keep me"}]},
  };
}

// 1. Offline clear keeps everything except the counter.
{
  const s = spentState();
  const cleared = clearPlanRevisionCounter(s);
  check("offline clear returns the cleared revision", cleared === 3, cleared);
  check("offline clear deletes only revision",
    !("revision" in s.standalonePlanReview), s.standalonePlanReview);
  check("offline clear keeps findings",
    JSON.stringify(s.standalonePlanReview.findings) === JSON.stringify([{id: "TASKS.md 2.3"}]),
    s.standalonePlanReview);
  check("offline clear keeps reviewFeedback",
    s.reviewFeedback?.["standalone-plan"]?.[0]?.finding === "keep me", s.reviewFeedback);
  check("offline clear keeps budgets and dead-ends",
    s.failureBudgets["infrastructureRetryBudget:mission"] === 2
    && s.continuationBudgets["continuationAllowance:task:standalone:phase-1:T9"] === 4
    && s.rolloverDeadEnds["continuationAllowance:task:standalone:phase-1:T9"].length === 1
    && s.noProgressGenerations["continuationAllowance:task:standalone:phase-1:T9"] === 1, s);
}

// 2. Offline clear with nothing spent is a null no-op.
{
  const s = spentState(); delete s.standalonePlanReview;
  const before = JSON.stringify(s);
  check("offline clear with no record returns null", clearPlanRevisionCounter(s) === null);
  check("offline clear with no record touches nothing", JSON.stringify(s) === before);
  const s2 = spentState(); delete s2.standalonePlanReview.revision;
  check("offline clear with counter already gone returns null",
    clearPlanRevisionCounter(s2) === null);
}

// 3. The new kind's key is distinct from every existing queue kind.
{
  check("scope constant is standalone-plan-revision",
    PLAN_REVISION_RESET_SCOPE === "standalone-plan-revision", PLAN_REVISION_RESET_SCOPE);
  check("key is distinct from the global key",
    PLAN_REVISION_RESET_KEY !== "__global__", PLAN_REVISION_RESET_KEY);
  check("key is colon-free (never a failure key <budget>:<scope>)",
    !PLAN_REVISION_RESET_KEY.includes(":"), PLAN_REVISION_RESET_KEY);
  check("key is not a continuation key",
    !PLAN_REVISION_RESET_KEY.startsWith("continuationAllowance:"), PLAN_REVISION_RESET_KEY);
}

// 4. Enqueue and consume round trip; nothing queued -> null.
{
  const q = queueFile();
  check("nothing queued returns null",
    applyPendingPlanRevisionReset(spentState(), q) === null);
  const s = spentState();
  enqueueResetRequest(q, planRevisionResetRequest(s.mission));
  check("enqueue stages the new kind",
    readResetRequests(q).some((r) => r?.key === PLAN_REVISION_RESET_KEY), readResetRequests(q));
  const restarted = applyPendingPlanRevisionReset(s, q);
  check("consume returns the restarted revision", restarted === 0, restarted);
  check("consume clears the counter", !("revision" in s.standalonePlanReview), s.standalonePlanReview);
  check("consume keeps findings", s.standalonePlanReview.findings.length === 1, s.standalonePlanReview);
  check("consume drains only its own entry", readResetRequests(q).length === 0, readResetRequests(q));
}

// 5. A request staged during the last revision fires before the cap check.
{
  const maxRevisions = 3;
  const s = spentState(); s.standalonePlanReview.revision = maxRevisions - 1;
  const q = queueFile();
  enqueueResetRequest(q, planRevisionResetRequest(s.mission));
  const restarted = applyPendingPlanRevisionReset(s, q);
  check("last-revision request applies", restarted === 0, restarted);
  check("restarted revision passes the revision>=maxRevisions cap check",
    restarted !== null && restarted < maxRevisions, {restarted, maxRevisions});
}

// 6. A request from another mission is ignored (counter kept, entry queued).
{
  const s = spentState("002-other-mission");
  const q = queueFile();
  enqueueResetRequest(q, planRevisionResetRequest("001-mine"));
  const before = s.standalonePlanReview.revision;
  check("foreign-mission request returns null",
    applyPendingPlanRevisionReset(s, q) === null);
  check("foreign-mission request keeps the counter",
    s.standalonePlanReview.revision === before, s.standalonePlanReview);
  check("foreign-mission request stays queued",
    readResetRequests(q).some((r) => r?.key === PLAN_REVISION_RESET_KEY), readResetRequests(q));
}

// 7. An early-armed request (nothing spent) stays queued until it matters.
{
  const s = spentState(); delete s.standalonePlanReview.revision;
  const q = queueFile();
  enqueueResetRequest(q, planRevisionResetRequest(s.mission));
  check("unspent counter returns null", applyPendingPlanRevisionReset(s, q) === null);
  check("unspent counter keeps the request queued",
    readResetRequests(q).some((r) => r?.key === PLAN_REVISION_RESET_KEY), readResetRequests(q));
}

// 8. Consuming the new kind leaves other kinds armed.
{
  const s = spentState();
  const q = queueFile();
  enqueueResetRequest(q, {key: "__global__", scope: "__global__", global: true});
  enqueueResetRequest(q, {key: "infrastructureRetryBudget:mission", scope: "mission"});
  enqueueResetRequest(q, planRevisionResetRequest(s.mission));
  check("mixed queue consumes only the new kind",
    applyPendingPlanRevisionReset(s, q) === 0, readResetRequests(q));
  const rest = readResetRequests(q).map((r) => r?.key).sort();
  check("global and failure entries stay queued",
    JSON.stringify(rest) === JSON.stringify(["__global__", "infrastructureRetryBudget:mission"]), rest);
}

fs.rmSync(tmp, {recursive: true, force: true});

// ---- 9. CLI wiring (task 1.2): offline, live-enqueue, refusal, source. ----
const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const AP_CJS = path.join(skillRoot, "bin", "ap.cjs");
const AUTOPILOT_SRC = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
let harness = null;
try{ harness = await import("./test-fixtures/workflow-order-harness.mjs"); }catch{ harness = null; }
const cliRepos = [];
function cliState(repo, s){
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(s, null, 2));
}
const cliRead = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
function cliRun(args, repo){
  const r = spawnSync(process.execPath, [AP_CJS, ...args, "--repo", repo], {encoding: "utf8"});
  return {status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`};
}
function cliSpent(mission = "086-cli-mission"){
  return {
    version: 1, mission, missionSeq: "086",
    failureBudgets: {"infrastructureRetryBudget:mission": 2},
    continuationBudgets: {"continuationAllowance:task:standalone:phase-1:T9": 4},
    rolloverDeadEnds: {"continuationAllowance:task:standalone:phase-1:T9": ["a"]},
    standalonePlanReview: {revision: 3, findings: [{id: "TASKS.md 2.3"}]},
    reviewFeedback: {"standalone-plan": [{finding: "keep me"}]},
  };
}
if(!harness){
  check("CLI harness loads", false, "workflow-order-harness.mjs missing");
}else{
  // 9a. Offline CLI clears only the counter.
  {
    const repo = harness.makeFixtureRepo("reset-plan-revision-cli-"); cliRepos.push(repo);
    harness.writeConfig(repo, {planningFramework: "standalone"});
    cliState(repo, cliSpent());
    const r = cliRun(["reset", "--scope", "standalone-plan-revision"], repo);
    const s = cliRead(repo);
    check("CLI offline exits 0", r.status === 0, r);
    check("CLI offline clears only the revision",
      !("revision" in (s.standalonePlanReview || {})), s.standalonePlanReview);
    check("CLI offline keeps findings and reviewFeedback",
      Array.isArray(s.standalonePlanReview?.findings) && s.standalonePlanReview.findings.length === 1
      && s.reviewFeedback?.["standalone-plan"]?.[0]?.finding === "keep me", s);
    check("CLI offline keeps budgets and dead-ends",
      s.failureBudgets?.["infrastructureRetryBudget:mission"] === 2
      && s.continuationBudgets?.["continuationAllowance:task:standalone:phase-1:T9"] === 4, s);
  }
  // 9b. Offline with nothing spent exits non-zero.
  {
    const repo = harness.makeFixtureRepo("reset-plan-revision-cli-"); cliRepos.push(repo);
    harness.writeConfig(repo, {planningFramework: "standalone"});
    const s0 = cliSpent(); delete s0.standalonePlanReview;
    cliState(repo, s0);
    const r = cliRun(["reset", "--scope", "standalone-plan-revision"], repo);
    check("CLI offline with nothing spent exits non-zero", r.status !== 0, r);
  }
  // 9c. Bare reset still clears the counter; other scopes leave it alone.
  {
    const repo = harness.makeFixtureRepo("reset-plan-revision-cli-"); cliRepos.push(repo);
    harness.writeConfig(repo, {planningFramework: "standalone"});
    cliState(repo, cliSpent());
    const r = cliRun(["reset"], repo);
    check("bare reset still clears the revision counter",
      r.status === 0 && cliRead(repo).standalonePlanReview?.revision === undefined, r);
    const repo2 = harness.makeFixtureRepo("reset-plan-revision-cli-"); cliRepos.push(repo2);
    harness.writeConfig(repo2, {planningFramework: "standalone"});
    cliState(repo2, cliSpent());
    const f = cliRun(["reset", "--scope", "infrastructureRetryBudget:mission"], repo2);
    const s2 = cliRead(repo2);
    check("other scopes leave the revision counter alone",
      f.status === 0 && s2.standalonePlanReview?.revision === 3
      && !("infrastructureRetryBudget:mission" in (s2.failureBudgets || {})), s2);
  }
  // 9d. Unknown scope still exits 1 and the refusal text lists the new scope.
  {
    const repo = harness.makeFixtureRepo("reset-plan-revision-cli-"); cliRepos.push(repo);
    harness.writeConfig(repo, {planningFramework: "standalone"});
    cliState(repo, cliSpent());
    const r = cliRun(["reset", "--scope", "no-such-scope-086"], repo);
    check("unknown scope still exits non-zero", r.status !== 0, r);
    check("refusal text lists the new scope", r.out.includes("standalone-plan-revision"), r.out.slice(-600));
  }
  // 9e. Live run enqueues the new kind (mission-bound) instead of clearing.
  if(process.platform === "win32"){
    console.log("SKIP live-enqueue CLI case on win32");
  }else{
    const {writeOwnerPid, readOwnerPid, verifyOwnerPid} = await import("./owner-pid.mjs");
    const repo = harness.makeFixtureRepo("reset-plan-revision-cli-"); cliRepos.push(repo);
    harness.writeConfig(repo, {planningFramework: "standalone"});
    cliState(repo, cliSpent("086-live-mission"));
    const fake = path.join(repo, "autopilot.mjs");
    fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
    let child = spawn(process.execPath, [fake, "full"], {cwd: repo, stdio: "ignore"});
    try{
      writeOwnerPid(child.pid, repo);
      let live = false;
      const deadline = Date.now() + 15000;
      while(Date.now() < deadline){
        try{ if(verifyOwnerPid(readOwnerPid(repo), repo) === true){ live = true; break; } }catch{ /* not yet */ }
        await new Promise((res) => setTimeout(res, 100));
      }
      check("live precondition: PID file verifies live", live);
      const r = cliRun(["reset", "--scope", "standalone-plan-revision"], repo);
      const out = r.out;
      check("live reset enqueues (exit 0 + REQUESTED)", r.status === 0 && out.includes("REQUESTED"), {status: r.status, tail: out.slice(-400)});
      let queued = null;
      try{
        const {readResetRequests} = await import("./reset-request-queue.mjs");
        queued = readResetRequests(path.join(repo, ".autopilot", "reset-request.json"));
      }catch(e){ queued = `read-error: ${e?.message || e}`; }
      check("live queue holds the new kind",
        Array.isArray(queued) && queued.some((entry) => entry?.key === PLAN_REVISION_RESET_KEY), queued);
      check("live queue entry is mission-bound",
        Array.isArray(queued) && queued.some((entry) => entry?.key === PLAN_REVISION_RESET_KEY && entry?.mission === "086-live-mission"), queued);
      check("live state keeps the counter queued (not cleared)",
        cliRead(repo).standalonePlanReview?.revision === 3, cliRead(repo).standalonePlanReview);
      // Consumed at the loop top / before the cap checks: the queued entry
      // applies through the real helper with revision restart.
      {
        const s = cliSpent("086-live-mission"); s.standalonePlanReview.revision = 2;
        const q = queueFile();
        const {enqueueResetRequest} = await import("./reset-request-queue.mjs");
        enqueueResetRequest(q, planRevisionResetRequest(s.mission));
        check("queued entry consumed with revision restart",
          applyPendingPlanRevisionReset(s, q) === 0 && !("revision" in s.standalonePlanReview), s.standalonePlanReview);
      }
    }finally{
      try{ if(child && child.exitCode === null) child.kill("SIGKILL"); }catch{}
    }
  }
  // 9f. Source wiring: dispatch, live path and loop consumption sites.
  check("wiring: autopilot imports the reset-plan-revision helper",
    AUTOPILOT_SRC.includes("./reset-plan-revision.mjs") && AUTOPILOT_SRC.includes("applyPendingPlanRevisionReset"), null);
  check("wiring: reset dispatch routes the new scope",
    AUTOPILOT_SRC.includes("PLAN_REVISION_RESET_SCOPE") && AUTOPILOT_SRC.includes("resetPlanRevisionCommand"), null);
  const applySites = (AUTOPILOT_SRC.match(/applyPendingPlanRevisionReset\(s,pendingResetPath\(\)\)/g) || []).length;
  check("wiring: loop top plus both pre-cap checks consume the queue (3 sites)", applySites === 3, applySites);
  check("wiring: cap checks restart instead of escalating",
    AUTOPILOT_SRC.includes("a request staged during the last revision fires before"), null);
  for(const repo of cliRepos){ try{ harness.cleanup(repo); }catch{} }
}
// ---- 10. Scope-list docs (task 1.3): usage lines name the new scope. ----
{
  const apCjs = fs.readFileSync(AP_CJS, "utf8");
  const readme = fs.readFileSync(path.join(skillRoot, "README.md"), "utf8");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  check("docs: bin/ap.cjs usage names standalone-plan-revision",
    apCjs.includes("standalone-plan-revision"), apCjs.slice(0, 200));
  check("docs: README.md names standalone-plan-revision",
    readme.includes("standalone-plan-revision"), null);
  check("docs: SKILL.md names standalone-plan-revision",
    skill.includes("standalone-plan-revision"), null);
}
if(failures){ console.error(`${failures} reset-plan-revision check(s) failed.`); process.exit(1); }
console.log("test-reset-plan-revision: ALL CHECKS PASSED");
