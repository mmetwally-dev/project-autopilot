import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import * as standalone from "../adapters/standalone.mjs";
import {ensureStandaloneSplit} from "./mission-naming.mjs";
import {saveReviewFeedback, loadReviewFeedback, clearReviewFeedbackByPrefix} from "./review-feedback.mjs";
import {failure, recordFailureBudget, clearStaleStandaloneBudgets} from "./failure-contract.mjs";

function makeRepo(){ return fs.mkdtempSync(path.join(os.tmpdir(),"ap-split-")); }
function writePlan(repo, mission, content){
  const f=standalone.planPath(repo, mission);
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f, content);
  return f;
}
function readPlan(repo, mission){ return fs.readFileSync(standalone.planPath(repo, mission),"utf8"); }
function readTasks(repo, mission){ return fs.readFileSync(standalone.tasksPath(repo, mission),"utf8"); }

let ok=0;
function check(name, cond, detail){
  if(cond){ console.log(`PASS ${name}`); ok++; return; }
  console.error(`FAIL ${name}${detail?` :: ${JSON.stringify(detail)}`:""}`);
  process.exitCode=1;
}

// 1. Fresh split preserves verbatim and done flags, strips PLAN.md, pointer added
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    writePlan(repo, mission, "# Plan\n\nObjective: demo\n\n- [ ] Task one — accept: one ; verify: check one\n  continuation line for task one\n- [x] Task two — accept: two ; verify: check two\n\nTrailing paragraph.\n");
    const s={mission};
    const r=ensureStandaloneSplit(repo, s);
    check("fresh split returns migrated true", r.migrated===true && r.splitPerformed===true, r);
    const tasksContent=readTasks(repo, mission);
    check("tasks contains Phase heading", tasksContent.startsWith("## Phase 1: General"), tasksContent.slice(0,60));
    check("tasks preserves continuation", tasksContent.includes("continuation line for task one"));
    check("tasks preserves done flag", tasksContent.includes("- [x] Task two"));
    const planAfter=readPlan(repo, mission);
    check("plan no longer has checklist", !planAfter.includes("- [ ] Task one") && !planAfter.includes("- [x] Task two"));
    check("plan has pointer", planAfter.includes("Tasks: ./TASKS.md"));
    check("plan retains trailing", planAfter.includes("Trailing paragraph"));
    check("tasks 1-indexed lines", standalone.tasks(repo, mission)[0].line===3, standalone.tasks(repo, mission)[0]);
    const ph=standalone.phases(repo, mission);
    check("phases shape", ph.length===1 && ph[0].tasks.length===2 && ph[0].tasks[0].line===3);
    check("state partial", standalone.state(repo, mission).status==="partial");
    check("detect both", standalone.detect(repo, mission)===true);
    // markDone with 1-indexed line
    standalone.markDone(repo, mission, 3);
    check("markDone 1-indexed", standalone.tasks(repo, mission)[0].done===true);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

// 2. Second call no-op (idempotent) when already split, no rewrite
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    writePlan(repo, mission, "# Plan\n\n- [ ] A\n- [ ] B\n");
    const s={mission};
    ensureStandaloneSplit(repo, s);
    const tasksBefore=readTasks(repo, mission);
    const planBefore=readPlan(repo, mission);
    const tStatBefore=fs.statSync(standalone.tasksPath(repo, mission)).mtimeMs;
    const pStatBefore=fs.statSync(standalone.planPath(repo, mission)).mtimeMs;
    const r2=ensureStandaloneSplit(repo, s);
    check("second call no migrated", r2.migrated===false && r2.splitPerformed===false, r2);
    check("tasks unchanged", readTasks(repo, mission)===tasksBefore);
    check("plan unchanged", readPlan(repo, mission)===planBefore);
    check("tasks mtime unchanged (no rewrite)", fs.statSync(standalone.tasksPath(repo, mission)).mtimeMs===tStatBefore);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

// 3. Crash-recovery: TASKS.md already identical, PLAN.md still has checklist -> heals PLAN.md, returns migrated true
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    writePlan(repo, mission, "# Plan\n\n- [ ] A\n- [ ] B\n");
    const s={mission};
    const r1=ensureStandaloneSplit(repo, s);
    check("initial split", r1.migrated===true);
    // Simulate crash: restore checklist into PLAN.md but leave TASKS.md intact
    const tasksContent=readTasks(repo, mission);
    fs.writeFileSync(standalone.planPath(repo, mission), "# Plan\n\n- [ ] A\n- [ ] B\n");
    fs.writeFileSync(standalone.tasksPath(repo, mission), tasksContent);
    const r2=ensureStandaloneSplit(repo, s);
    check("recovery returns migrated true", r2.migrated===true && r2.splitPerformed===false, r2);
    check("recovery heals plan", !readPlan(repo, mission).includes("- [ ] A") && readPlan(repo, mission).includes("Tasks: ./TASKS.md"));
    check("recovery preserves tasks", readTasks(repo, mission)===tasksContent);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

// 4. MIGRATION_CONFLICT when TASKS.md exists and differs -> zero modifications
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    writePlan(repo, mission, "# Plan\n\n- [ ] A\n- [ ] B\n");
    // Pre-create different TASKS.md
    const tasksFile=standalone.tasksPath(repo, mission);
    fs.mkdirSync(path.dirname(tasksFile),{recursive:true});
    fs.writeFileSync(tasksFile, "## Phase 1: General\n\n- [ ] DIFFERENT\n");
    const planBefore=readPlan(repo, mission);
    const tasksBefore=readTasks(repo, mission);
    const s={mission};
    let threw=false;
    try{ ensureStandaloneSplit(repo,s); }catch(e){ threw=/MIGRATION_CONFLICT/.test(e.message); }
    check("conflict throws MIGRATION_CONFLICT", threw===true);
    check("plan untouched on conflict", readPlan(repo, mission)===planBefore);
    check("tasks untouched on conflict", readTasks(repo, mission)===tasksBefore);
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

// 5. Gated cleanup: fresh split clears stale old-style keys once
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    writePlan(repo, mission, "# Plan\n\n- [ ] A\n");
    const s={mission, reviewFeedback:{}, failureBudgets:{}};
    // Seed stale old-style keys (pre-split line-number shape)
    saveReviewFeedback(s, "standalone-task:2", ["old stale"]);
    saveReviewFeedback(s, "standalone-task:3", ["old stale 2"]);
    recordFailureBudget(s, {failure_budgets:{}}, failure("PROCESS_EXIT_NONZERO","adapter",true), "task:standalone:2");
    recordFailureBudget(s, {failure_budgets:{}}, failure("PROCESS_EXIT_NONZERO","adapter",true), "task:standalone:3");
    const beforeKeys=Object.keys(s.reviewFeedback).length;
    check("seeded 2 feedback keys", beforeKeys===2);
    const r=ensureStandaloneSplit(repo, s);
    check("split migrated true for cleanup", r.migrated===true);
    // Simulate autopilot gated clear
    if(r.migrated){ clearReviewFeedbackByPrefix(s,"standalone-task:"); clearStaleStandaloneBudgets(s); }
    check("stale feedback cleared", Object.keys(s.reviewFeedback||{}).length===0);
    check("stale budgets cleared", !Object.keys(s.failureBudgets||{}).some(k=>k.includes(":task:standalone:")));
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

// 6. After initial migration, new legitimate feedback/budgets survive second call
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    writePlan(repo, mission, "# Plan\n\n- [ ] A\n");
    const s={mission, reviewFeedback:{}, failureBudgets:{}};
    const r1=ensureStandaloneSplit(repo, s);
    if(r1.migrated){ clearReviewFeedbackByPrefix(s,"standalone-task:"); clearStaleStandaloneBudgets(s); }
    // Now create new legitimate post-split feedback (new file:line shape)
    const tasksFile=standalone.tasksPath(repo, mission);
    // TASKS.md line for task A is 3 (##, blank, task)
    saveReviewFeedback(s, "standalone-task:TASKS.md:3", ["new legit"]);
    recordFailureBudget(s, {failure_budgets:{}}, failure("PROCESS_EXIT_NONZERO","adapter",true), "task:standalone:TASKS.md:3");
    const fbBefore=JSON.stringify(s.reviewFeedback);
    const budBefore=JSON.stringify(s.failureBudgets);
    const r2=ensureStandaloneSplit(repo, s);
    check("second call not migrated", r2.migrated===false && r2.splitPerformed===false, r2);
    // Must NOT have cleared new legit keys (caller gates on migrated, so no clear)
    check("new feedback untouched after second split", JSON.stringify(s.reviewFeedback)===fbBefore);
    check("new budgets untouched after second split", JSON.stringify(s.failureBudgets)===budBefore);
    // Also explicitly verify that if someone incorrectly did unconditional clear, it would have been caught
    // (we don't actually do it, we just ensure gated path preserves)
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

// 7. Ambiguity: non-checklist non-indented content between tasks between first and last triggers conflict with zero modifications
// (conservative: ambiguous section fails closed)
{
  const repo=makeRepo();
  try{
    const mission="001-demo";
    // Checklist with a non-indented paragraph between tasks that is not blank/indent — ambiguous
    writePlan(repo, mission, "# Plan\n\n- [ ] A\nNon-indented paragraph between tasks\n- [ ] B\n");
    const s={mission};
    const planBefore=readPlan(repo, mission);
    let threw=false;
    try{ ensureStandaloneSplit(repo,s); }catch(e){ threw=/MIGRATION_CONFLICT/.test(e.message); }
    // The current heuristic marks this as ambiguous only if not indented; this paragraph is at col 0, so ambiguous=true
    // Should throw and leave zero modifications
    check("ambiguous checklist fails closed", threw===true);
    check("plan untouched on ambiguous", readPlan(repo, mission)===planBefore);
    check("no TASKS.md created on ambiguous", !fs.existsSync(standalone.tasksPath(repo, mission)));
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}

console.log(`standalone split tests: ${ok} checks passed`);
