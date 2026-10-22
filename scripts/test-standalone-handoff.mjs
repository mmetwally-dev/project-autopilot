import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, scopedDeltaChunks, SCOPED_DELTA_END_MARKER} from "./implementation-baseline.mjs";
import {buildStandaloneHandoff, sanitizeSummary, truncationWarning, PHASE_DELTA_BUDGET, PHASE_HANDOFF_BUDGET, MISSION_DELTA_BUDGET, MISSION_HANDOFF_BUDGET} from "./standalone-handoff.mjs";

function makeRepo(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ap-ho-"));
  spawnSync("git",["init"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  spawnSync("git",["config","user.email","test@test.com"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  spawnSync("git",["config","user.name","Test"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  fs.writeFileSync(path.join(dir,"README.md"),"# test\n");
  spawnSync("git",["add","."],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  spawnSync("git",["commit","-m","init"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  return dir;
}

let ok=0;
let failed=0;
function check(name,cond,detail){
  if(cond){console.log(`PASS ${name}`);ok++;return;}
  console.error(`FAIL ${name}${detail?` :: ${JSON.stringify(detail)}`:""}`);
  failed++;
}

const TASKS=[{file:"/repo/TASKS.md",line:3,text:"Do the thing"}];
const CHUNKS=[{path:"a.js",text:"diff --git a/a.js b/a.js\n+one"}];

// ===================================================================
// 1. Structure per kind
// ===================================================================
{
  const r=buildStandaloneHandoff({kind:"PHASE_REVIEW",
    phaseName:"Phase 1 — Build",phaseIndex:0,phaseTotal:2,phaseTasks:TASKS,attempt:1,
    deltaChunks:CHUNKS,baselineKey:"mission-x-phase-0",
    declaredPaths:[],implementationSummary:"Changed a.js.\nFiles: a.js\nTests: none\nRisks: none"});
  check("review: anchor phrase",r.text.includes("Review the whole phase (all tasks together) — not task by task."));
  check("review: Phase line preserved",r.text.includes("Phase: Phase 1 — Build"));
  check("review: progress line",r.text.includes("Progress: phase 1/2; attempt 1"));
  check("review: task scope",r.text.includes("- [T1] Do the thing (/repo/TASKS.md:3)"));
  check("review: no Requirements line (fed via relay channel, not handoff text)",!r.text.includes("Requirements:"));
  check("review: report section",r.text.includes("Implementer report (untrusted"));

  // TASK-20: the reviewer's task list carries the 1-based label step 2/3 map
  // findings back through, so pin the numbering and the position on a scope
  // that has more than one task.
  const TWO=[{file:"/repo/TASKS.md",line:3,text:"Do the thing"},{file:"/repo/TASKS.md",line:4,text:"Then the other"}];
  const t=buildStandaloneHandoff({kind:"PHASE_REVIEW",
    phaseName:"Phase 1 — Build",phaseIndex:0,phaseTotal:1,phaseTasks:TWO,attempt:1,
    deltaChunks:CHUNKS,baselineKey:"k",declaredPaths:[],implementationSummary:""});
  check("review: task labels are 1-based and positional",
    t.text.includes("- [T1] Do the thing (/repo/TASKS.md:3)")&&t.text.includes("- [T2] Then the other (/repo/TASKS.md:4)"),
    (t.text.match(/Tasks:\n([\s\S]{0,200})/)||[])[1]);
  check("review: phase scope prose",r.text.includes("Scoped implementation delta for THIS PHASE only"));
  check("review: markers exactly once",(r.text.match(/AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE/g)||[]).length===1);
  check("review: meta shape",r.meta.kind==="PHASE_REVIEW"&&r.meta.truncated===false&&r.meta.baselineKey==="mission-x-phase-0");
  check("review: EOL-normalized diff fallback",r.text.includes("git diff --ignore-cr-at-eol")&&r.text.includes("git -c core.autocrlf=input diff"));

  const v=buildStandaloneHandoff({kind:"PHASE_VERIFY",
    phaseName:"Phase 1 — Build",phaseIndex:1,phaseTotal:2,phaseTasks:TASKS,attempt:2,
    deltaChunks:CHUNKS,baselineKey:"k",declaredPaths:[],
    implementationSummary:"did stuff"});
  check("verify: header",v.text.includes("Verify this phase after implementation and code review."));
  check("verify: progress zero-based handled",v.text.includes("Progress: phase 2/2; attempt 2"));
  check("verify: report section",v.text.includes("Implementer report (untrusted"));
  check("verify: no Requirements line (fed via relay channel, not handoff text)",!v.text.includes("Requirements:"));
  check("verify: EOL-normalized diff fallback",v.text.includes("git diff --ignore-cr-at-eol")&&v.text.includes("git -c core.autocrlf=input diff"));
  try{buildStandaloneHandoff({kind:"PHASE_VERIFY",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
    requirements:["node"],deltaChunks:CHUNKS,baselineKey:"k",declaredPaths:[],
    implementationSummary:""});check("requirements param rejected",false);}
  catch(e){check("requirements param rejected",e.code==="INVALID_HANDOFF_REQUIREMENTS");}

  const m=buildStandaloneHandoff({kind:"MISSION_FINAL",
    deltaChunks:CHUNKS,baselineKey:"mission-x",declaredPaths:[],
    planPath:"/repo/PLAN.md",tasksPath:"/repo/TASKS.md",implementationSummary:""});
  check("final: plan/tasks header",m.text.includes("Final repository review against standalone plan /repo/PLAN.md and tasks /repo/TASKS.md."));
  check("final: no task scope",!m.text.includes("Tasks:"));
  check("final: mission scope prose",m.text.includes("Scoped implementation delta for THIS ENTIRE MISSION"));
  check("final: mission marker",(m.text.match(/AUTOPILOT_SCOPED_DELTA_BEGIN:MISSION/g)||[]).length===1);
  check("final: empty report suppressed",!m.text.includes("Implementer report"));
  check("final: EOL-normalized diff fallback",m.text.includes("git diff --ignore-cr-at-eol")&&m.text.includes("git -c core.autocrlf=input diff"));

  // Empty summary suppresses the section everywhere
  const ns=buildStandaloneHandoff({kind:"PHASE_REVIEW",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
    deltaChunks:[],baselineKey:"k",declaredPaths:[],implementationSummary:"   "});
  check("empty summary suppressed",!ns.text.includes("Implementer report"));
  check("empty delta placeholder",ns.text.includes("(empty — no repository changes in scope)"));
}

// ===================================================================
// 1b. TASK-23: PHASE_REREVIEW (scoped code re-review)
// ===================================================================
{
  const TWO=[{file:"/repo/TASKS.md",line:3,text:"Do the thing"},{file:"/repo/TASKS.md",line:4,text:"Then the other"}];
  const r=buildStandaloneHandoff({kind:"PHASE_REREVIEW",
    phaseName:"Phase 1 — Build",phaseIndex:0,phaseTotal:1,phaseTasks:TWO,attempt:2,
    deltaChunks:CHUNKS,changedFiles:["a.js","b.js"],baselineKey:"mission-x-phase-0-review-r2",
    declaredPaths:[],implementationSummary:"Fixed a.js."});
  check("rereview: header",r.text.includes("Re-review after a fix."));
  check("rereview: findings instruction",r.text.includes("FEEDBACK TO ADDRESS"));
  check("rereview: Phase line preserved",r.text.includes("Phase: Phase 1 — Build"));
  check("rereview: progress line",r.text.includes("Progress: phase 1/1; attempt 2"));
  check("rereview: task labels are 1-based and positional",
    r.text.includes("- [T1] Do the thing (/repo/TASKS.md:3)")&&r.text.includes("- [T2] Then the other (/repo/TASKS.md:4)"));
  check("rereview: FIX markers exactly once",
    (r.text.match(/AUTOPILOT_SCOPED_DELTA_BEGIN:FIX/g)||[]).length===1&&r.text.includes(SCOPED_DELTA_END_MARKER));
  check("rereview: no PHASE marker",(r.text.match(/AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE/g)||[]).length===0);
  check("rereview: changed-files line",r.text.includes("Changed files in this phase so far: a.js, b.js"));
  check("rereview: fix delta bytes intact",r.text.includes("+one"));
  check("rereview: meta shape",r.meta.kind==="PHASE_REREVIEW"&&r.meta.truncated===false&&r.meta.baselineKey==="mission-x-phase-0-review-r2");
  check("rereview: EOL-normalized diff fallback",r.text.includes("git diff --ignore-cr-at-eol")&&r.text.includes("git -c core.autocrlf=input diff"));

  // Empty fix diff: still a re-review, with the empty-fix wording in place
  // of the delta — the review is never skipped.
  const e=buildStandaloneHandoff({kind:"PHASE_REREVIEW",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:2,
    deltaChunks:[],changedFiles:[],baselineKey:"k",declaredPaths:[],implementationSummary:""});
  check("rereview: empty fix wording",e.text.includes("The fix changed no files."));
  check("rereview: empty phase files line",e.text.includes("Changed files in this phase so far: none"));
  check("rereview: old empty placeholder absent",!e.text.includes("(empty — no repository changes in scope)"));

  // Truncation uses the same path as PHASE_REVIEW and still reports it.
  const big=[{path:"a.js",text:`diff --git a/a.js b/a.js\n${"x".repeat(500)}`},
             {path:"b.js",text:`diff --git a/b.js b/b.js\n${"y".repeat(500)}`}];
  const t=buildStandaloneHandoff({kind:"PHASE_REREVIEW",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:2,
    deltaChunks:big,changedFiles:["a.js","b.js"],baselineKey:"k",declaredPaths:[],
    implementationSummary:"",maxDeltaChars:300,maxHandoffChars:4000});
  check("rereview: truncation still reports meta.truncated",t.meta.truncated===true);
  check("rereview: truncation notice inside FIX markers",
    t.text.includes("TRUNCATED: omitted")&&(t.text.match(/AUTOPILOT_SCOPED_DELTA_BEGIN:FIX/g)||[]).length===1);
}

// ===================================================================
// 2. Budgets and truncation (small explicit budgets keep tests cheap)
// ===================================================================
{
  const big=[{path:"a.js",text:`diff --git a/a.js b/a.js\n${"x".repeat(500)}`},
             {path:"b.js",text:`diff --git a/b.js b/b.js\n${"y".repeat(500)}`},
             {path:"c.js",text:`diff --git a/c.js b/c.js\n${"z".repeat(500)}`}];
  // Under budget: delta bytes pass through untouched
  const under=buildStandaloneHandoff({kind:"PHASE_REVIEW",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
    deltaChunks:big.slice(0,1),baselineKey:"k",declaredPaths:[],
    implementationSummary:"",maxDeltaChars:5000,maxHandoffChars:9000});
  check("under budget: not truncated",under.meta.truncated===false);
  check("under budget: delta bytes intact",under.text.includes("x".repeat(500)));
  check("under budget: counts",under.meta.includedChunks===1&&under.meta.omittedChunks===0);

  // Over budget: truncate with notice, lists, instruction, intact markers
  const over=buildStandaloneHandoff({kind:"PHASE_REVIEW",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
    deltaChunks:big,baselineKey:"mission-k-phase-0",declaredPaths:[],
    implementationSummary:"",maxDeltaChars:900,maxHandoffChars:4000});
  check("over budget: truncated",over.meta.truncated===true);
  check("over budget: notice",over.text.includes("TRUNCATED: omitted"));
  check("over budget: omitted files listed",over.text.includes("Omitted files:"));
  check("over budget: worktree instruction",over.text.includes("Read the omitted files from the worktree with ranged reads"));
  check("over budget: omitted line counts",/Omitted files: .*\(\+\d+\/−\d+\)/.test(over.text));
  check("over budget: markers intact",
    (over.text.match(/AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE/g)||[]).length===1&&over.text.includes(SCOPED_DELTA_END_MARKER));
  check("over budget: meta consistent",
    over.meta.includedChunks+over.meta.omittedChunks===3&&over.meta.omittedFiles.length===over.meta.omittedChunks);
  check("over budget: fits budgets",over.text.length<=4000);
  // Caller warning carries the required fields
  const warn=truncationWarning(over.meta);
  check("warning: baseline + counts + chars",
    warn.includes("mission-k-phase-0")&&warn.includes("omitted")&&warn.includes("chars"));

  // Single oversize chunk is omitted whole, never split
  const one=[{path:"big.js",text:`diff --git a/big.js b/big.js\n${"q".repeat(2000)}`}];
  const single=buildStandaloneHandoff({kind:"PHASE_REVIEW",
    phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
    deltaChunks:one,baselineKey:"k",declaredPaths:[],
    implementationSummary:"",maxDeltaChars:800,maxHandoffChars:4000});
  check("oversize chunk: omitted whole",single.meta.truncated&&single.meta.includedChunks===0&&single.meta.omittedFiles[0]==="big.js");
  check("oversize chunk: no partial content",!single.text.includes("q".repeat(100)));

  // Impossible budget throws before any role launch
  try{
    buildStandaloneHandoff({kind:"PHASE_REVIEW",
      phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
      deltaChunks:big,baselineKey:"k",declaredPaths:[],
      implementationSummary:"",maxDeltaChars:10,maxHandoffChars:20});
    check("impossible budget: throws",false);
  }catch(e){check("impossible budget: throws",e.code==="HANDOFF_TOO_LARGE");}

  // Invalid budgets fail closed
  for(const bad of [0,-5,1.5,NaN,"60k"]){
    try{
      buildStandaloneHandoff({kind:"PHASE_REVIEW",
        phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
        deltaChunks:[],baselineKey:"k",declaredPaths:[],
        implementationSummary:"",maxDeltaChars:bad,maxHandoffChars:4000});
      check(`invalid budget rejected (${JSON.stringify(bad)})`,false);
    }catch(e){check(`invalid budget rejected (${JSON.stringify(bad)})`,e.code==="INVALID_HANDOFF_BUDGET");}
  }

  // Defaults match the pinned constants
  check("phase defaults",PHASE_DELTA_BUDGET===60000&&PHASE_HANDOFF_BUDGET===70000);
  check("mission defaults",MISSION_DELTA_BUDGET===80000&&MISSION_HANDOFF_BUDGET===95000);
}

// ===================================================================
// 3. Summary clamp + validation errors
// ===================================================================
{
  check("summary: short passthrough",sanitizeSummary("hello") === "hello");
  const long=sanitizeSummary("A".repeat(5000));
  check("summary: clamped to 2000 total inclusive of marker",long.length<=2000&&long.endsWith("… [truncated]"));
  check("summary: control chars stripped",!sanitizeSummary("a\x00b\x1fc").includes("\x00"));

  const base={phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:TASKS,attempt:1,
    deltaChunks:[],baselineKey:"k",declaredPaths:[],implementationSummary:""};
  try{buildStandaloneHandoff({...base,kind:"NOPE"});check("unknown kind throws",false);}
  catch(e){check("unknown kind throws",e.code==="INVALID_HANDOFF_KIND");}
  try{buildStandaloneHandoff({...base,kind:"PHASE_REVIEW",phaseTasks:[]});check("empty tasks throws",false);}
  catch(e){check("empty tasks throws",e.code==="INVALID_HANDOFF_TASKS");}
  try{buildStandaloneHandoff({...base,kind:"MISSION_FINAL"});check("final needs paths",false);}
  catch(e){check("final needs paths",e.code==="INVALID_HANDOFF_PATHS");}
  try{buildStandaloneHandoff({...base,kind:"PHASE_REVIEW",baselineKey:""});check("empty baseline throws",false);}
  catch(e){check("empty baseline throws",e.code==="INVALID_HANDOFF_BASELINE");}
}

// ===================================================================
// 4. scopedDeltaChunks structured shape
// ===================================================================
{
  const repo=makeRepo();
  try{
    const key="handoff-chunks";
    ensureBaseline(repo,key,{mission:"m",declaredPaths:[]});
    fs.writeFileSync(path.join(repo,"a.js"),"console.log(1);\n");
    const chunks=scopedDeltaChunks(repo,key,{mission:"m",declaredPaths:[]});
    check("chunks: array of {path,text}",Array.isArray(chunks)&&chunks.length===1&&chunks[0].path==="a.js"&&typeof chunks[0].text==="string");
    check("chunks: path matches loop rel, not re-parsed",chunks[0].path==="a.js");
    check("chunks: text is the diff",chunks[0].text.includes("a.js"));
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

console.log(`\n${ok} passed, ${failed} failed`);
if(failed) process.exit(1);
