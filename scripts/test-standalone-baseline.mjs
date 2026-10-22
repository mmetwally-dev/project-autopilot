import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
import * as standalone from "../adapters/standalone.mjs";
import {ensureBaseline, scopedDelta, sanitizeKeySegment, scopedDeltaBeginMarker, SCOPED_DELTA_END_MARKER, listWorktreeEntries} from "./implementation-baseline.mjs";
import {validateStandaloneSnapshot} from "./mission-naming.mjs";

function makeRepo(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ap-bl-"));
  // Initialize a real git repo so git status/diff commands work
  spawnSync("git",["init"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  spawnSync("git",["config","user.email","test@test.com"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  spawnSync("git",["config","user.name","Test"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  fs.writeFileSync(path.join(dir,"README.md"),"# test\n");
  spawnSync("git",["add","."],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  spawnSync("git",["commit","-m","init"],{cwd:dir,encoding:"utf8",stdio:"pipe",env:withoutOuterGitGuard(process.env)});
  return dir;
}
function writePlan(repo,mission,content){
  const f=standalone.planPath(repo,mission);
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,content);
}
function writeTasks(repo,mission,content){
  const f=standalone.tasksPath(repo,mission);
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,content);
}
function baselineDir(repo,key){ return path.join(repo,".autopilot","baseline",key); }
function manifestPath(repo,key){ return path.join(baselineDir(repo,key),"manifest.json"); }

let ok=0;
let failed=0;
function check(name,cond,detail){
  if(cond){console.log(`PASS ${name}`);ok++;return;}
  console.error(`FAIL ${name}${detail?` :: ${JSON.stringify(detail)}`:""}`);
  failed++;
}

// ═══════════════════════════════════════════════════════════════════
// §1 validateDeclaredPath
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const {validateDeclaredPath}=await import("./implementation-baseline.mjs");
    // Current-mission FINDINGS.md inside .autopilot/ allowed
    const ok1=validateDeclaredPath(repo,"001-demo",".autopilot/missions/001-demo/FINDINGS.md");
    check("validateDeclaredPath: current-mission FINDINGS.md allowed",ok1===".autopilot/missions/001-demo/FINDINGS.md",ok1);
    // Other-mission baseline rejected
    try{validateDeclaredPath(repo,"001-demo",".autopilot/missions/002-other/PLAN.md");check("validateDeclaredPath: other-mission baseline rejected",false,"should have thrown");}
    catch(e){check("validateDeclaredPath: other-mission baseline rejected",e.code==="UNSAFE_DELIVERABLE_PATH",e.message);}
    // Reserved paths rejected
    for(const bad of [".autopilot/missions/001-demo/baseline/foo",".autopilot/missions/001-demo/runs/foo",".autopilot/missions/001-demo/state.json",".autopilot/missions/001-demo/PLAN.md",".autopilot/missions/001-demo/TASKS.md"]){
      try{validateDeclaredPath(repo,"001-demo",bad);check(`validateDeclaredPath: reserved path rejected (${bad})`,false,"should have thrown");}
      catch(e){check(`validateDeclaredPath: reserved path rejected (${bad})`,e.code==="UNSAFE_DELIVERABLE_PATH",e.message);}
    }
    // Absolute POSIX
    try{validateDeclaredPath(repo,"m","/etc/passwd");check("validateDeclaredPath: POSIX absolute rejected",false);}
    catch(e){check("validateDeclaredPath: POSIX absolute rejected",e.code==="UNSAFE_DELIVERABLE_PATH");}
    // UNC
    try{validateDeclaredPath(repo,"m","\\\\server\\share");check("validateDeclaredPath: UNC absolute rejected",false);}
    catch(e){check("validateDeclaredPath: UNC absolute rejected",e.code==="UNSAFE_DELIVERABLE_PATH");}
    // Windows drive
    try{validateDeclaredPath(repo,"m","C:\\Windows\\System32");check("validateDeclaredPath: Windows drive absolute rejected",false);}
    catch(e){check("validateDeclaredPath: Windows drive absolute rejected",e.code==="UNSAFE_DELIVERABLE_PATH");}
    // C:relative (drive but relative — still invalid)
    try{validateDeclaredPath(repo,"m","C:relative");check("validateDeclaredPath: C:relative rejected",false);}
    catch(e){check("validateDeclaredPath: C:relative rejected",e.code==="UNSAFE_DELIVERABLE_PATH");}
    // Empty/root/dot
    for(const bad of ["",".","..","/"]){
      try{validateDeclaredPath(repo,"m",bad);check(`validateDeclaredPath: sentinel rejected (${JSON.stringify(bad)})`,false);}
      catch(e){check(`validateDeclaredPath: sentinel rejected (${JSON.stringify(bad)})`,e.code==="UNSAFE_DELIVERABLE_PATH");}
    }
    // Valid relative path accepted
    const ok2=validateDeclaredPath(repo,"m","dist/index.js");
    check("validateDeclaredPath: valid relative accepted",ok2==="dist/index.js",ok2);
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §2 Symlink ancestor rejection
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const {validateDeclaredPath}=await import("./implementation-baseline.mjs");
    const linkDir=path.join(repo,"linkdir");
    try{fs.symlinkSync(path.join(repo,"target"),linkDir);}
    catch(e){if(e.code!=="EPERM")throw e;}// Windows without privilege
    let isLink=false;
    try{isLink=fs.lstatSync(linkDir).isSymbolicLink();}catch{}
    if(isLink){
      try{validateDeclaredPath(repo,"m","linkdir/file.txt");check("symlink ancestor rejected",false);}
      catch(e){check("symlink ancestor rejected",e.code==="UNSAFE_DELIVERABLE_PATH");}
    }else{
      console.log("SKIP symlink ancestor test (no symlink privilege)");
    }
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §3 Versioned manifest v1 compat + v2 declaredPaths
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const key="test-key";
    // Create a v1 manifest (flat map, no version/declaredPaths)
    fs.mkdirSync(baselineDir(repo,key),{recursive:true});
    fs.writeFileSync(manifestPath(repo,key),JSON.stringify({"README.md":{type:"file"}}));
    // v1 compat: ensureBaseline returns false (manifest exists), no declaredPaths mismatch
    const created=ensureBaseline(repo,key,{mission:"m",declaredPaths:[]});
    check("v1 compat: ensureBaseline no-op on existing manifest",created===false);
    // scopedDelta with v1 manifest + empty declaredPaths: should work
    const delta=scopedDelta(repo,key,{mission:"m",declaredPaths:[]});
    check("v1 compat: scopedDelta works with empty declaredPaths",typeof delta==="string");
    // scopedDelta with v1 manifest + non-empty declaredPaths: DECLARATION_MISMATCH
    try{
      scopedDelta(repo,key,{mission:"m",declaredPaths:["new-file.js"]});
      check("v1 compat: declaredPaths mismatch throws",false);
    }catch(e){check("v1 compat: declaredPaths mismatch throws",e.code==="DECLARATION_MISMATCH",e.message);}
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §4 Versioned manifest v2 stored declaredPaths + mismatch on resume
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const key="v2-key";
    fs.mkdirSync(path.join(repo,"dist"),{recursive:true});
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// initial");
    ensureBaseline(repo,key,{mission:"m",declaredPaths:["dist/out.js"]});
    const manifest=JSON.parse(fs.readFileSync(manifestPath(repo,key),"utf8"));
    check("v2 manifest has version",manifest.version===2);
    check("v2 manifest has declaredPaths",Array.isArray(manifest.declaredPaths)&&manifest.declaredPaths[0]==="dist/out.js");
    // Resume with same declaredPaths: ok
    const created2=ensureBaseline(repo,key,{mission:"m",declaredPaths:["dist/out.js"]});
    check("v2 resume same declaredPaths: no-op",created2===false);
    // Resume with different declaredPaths: DECLARATION_MISMATCH
    try{ensureBaseline(repo,key,{mission:"m",declaredPaths:["dist/other.js"]});check("v2 mismatch throws",false);}
    catch(e){check("v2 mismatch throws",e.code==="DECLARATION_MISMATCH",e.message);}
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §3b Unknown manifest version: fail-closed
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const key="unknown-ver";
    // Write a corrupted manifest with unknown version
    const dir=path.join(repo,".autopilot","baseline",key);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({version:99,entries:{}}));
    try{scopedDelta(repo,key);check("unknown version: throws",false);}
    catch(e){check("unknown version: throws",e.code==="UNKNOWN_MANIFEST_VERSION");}
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §5 Declared deliverables parsing (union inline + heading)
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const mission="001-decl";
    writePlan(repo,mission,`# Plan\n\n`+
      `<!-- autopilot-deliverable: dist/a.js -->\n`+
      `<!-- autopilot-deliverable: dist/b.js -->\n`+
      `## Deliverables\n`+
      `- dist/c.js\n`+
      `- dist/d.js\n`+
      `## Implementation\n`+
      `- This is NOT a deliverable\n`);
    const paths=standalone.declaredDeliverables(repo,mission);
    check("declaredDeliverables: counts",paths.length===4,paths);
    check("declaredDeliverables: inline a",paths.includes("dist/a.js"));
    check("declaredDeliverables: inline b",paths.includes("dist/b.js"));
    check("declaredDeliverables: heading c",paths.includes("dist/c.js"));
    check("declaredDeliverables: heading d",paths.includes("dist/d.js"));
    check("declaredDeliverables: no implementation line",!paths.some(p=>p.includes("implementation")));
    // Dedup: same path twice
    writePlan(repo,mission,`# Plan\n\n<!-- autopilot-deliverable: dup.js -->\n<!-- autopilot-deliverable: dup.js -->\n`);
    const duped=standalone.declaredDeliverables(repo,mission);
    check("declaredDeliverables: dedup",duped.length===1&&duped[0]==="dup.js");
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §5b TASKS.md deliverables (primary per-task declaration channel)
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const mission="001-tasks";
    // TASKS.md inline comments only
    writeTasks(repo,mission,`## Phase 1\n\n- [ ] Task one <!-- autopilot-deliverable: out/a.js -->\n- [ ] Task two <!-- autopilot-deliverable: out/b.js -->\n`);
    const taskOnly=standalone.declaredDeliverables(repo,mission);
    check("TASKS.md inline: counts",taskOnly.length===2,taskOnly);
    check("TASKS.md inline: a.js",taskOnly.includes("out/a.js"));
    check("TASKS.md inline: b.js",taskOnly.includes("out/b.js"));
    // Union: TASKS.md + PLAN.md
    writePlan(repo,mission,`# Plan\n\n## Deliverables\n- plan/c.js\n`);
    const union=standalone.declaredDeliverables(repo,mission);
    check("TASKS.md+PLAN.md union: counts",union.length===3,union);
    check("TASKS.md+PLAN.md union: has plan/c.js",union.includes("plan/c.js"));
    // Dedup across files
    writeTasks(repo,mission,`## Phase 1\n\n- [ ] Task <!-- autopilot-deliverable: shared.js -->\n`);
    writePlan(repo,mission,`# Plan\n\n<!-- autopilot-deliverable: shared.js -->\n`);
    const crossDedup=standalone.declaredDeliverables(repo,mission);
    check("TASKS.md+PLAN.md dedup",crossDedup.length===1&&crossDedup[0]==="shared.js");
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §5c declaredDeliverables fail-closed on unsafe paths
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const mission="001-unsafe";
    // Absolute path
    writePlan(repo,mission,`# Plan\n\n<!-- autopilot-deliverable: /etc/passwd -->\n`);
    try{standalone.declaredDeliverables(repo,mission);check("fail-closed: absolute throws",false);}
    catch(e){check("fail-closed: absolute throws",e.code==="UNSAFE_DELIVERABLE_PATH");}
    // Traversal
    writePlan(repo,mission,`# Plan\n\n<!-- autopilot-deliverable: ../../outside.txt -->\n`);
    try{standalone.declaredDeliverables(repo,mission);check("fail-closed: traversal throws",false);}
    catch(e){check("fail-closed: traversal throws",e.code==="UNSAFE_DELIVERABLE_PATH");}
    // UNC
    writePlan(repo,mission,`# Plan\n\n<!-- autopilot-deliverable: \\\\server\\share\\file.txt -->\n`);
    try{standalone.declaredDeliverables(repo,mission);check("fail-closed: UNC throws",false);}
    catch(e){check("fail-closed: UNC throws",e.code==="UNSAFE_DELIVERABLE_PATH");}
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §5d ## Deliverables skips fenced code blocks
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const mission="001-fenced";
    writePlan(repo,mission,`# Plan\n\n## Deliverables\n\n`+
      `- real.js\n`+
      "```\n- fenced/fake.js\n```\n"+
      `- also-real.js\n`);
    const paths=standalone.declaredDeliverables(repo,mission);
    check("fenced: real.js included",paths.includes("real.js"));
    check("fenced: also-real.js included",paths.includes("also-real.js"));
    check("fenced: fake.js excluded",!paths.some(p=>p.includes("fenced")));
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §6 Snapshot tasks (standalone.snapshotTasks)
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const mission="snap-test";
    writeTasks(repo,mission,"## Phase 1: Build\n\n- [ ] Task one\n- [x] Task two\n");
    const snap=standalone.snapshotTasks(repo,mission);
    check("snapshotTasks: shape",snap.length===2&&snap[0].text==="Task one"&&snap[0].done===false&&snap[1].done===true);
    check("snapshotTasks: file matches tasksPath",snap[0].file===standalone.tasksPath(repo,mission));
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §7 validateStandaloneSnapshot
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const mission="val-snap";
    const tp=standalone.tasksPath(repo,mission);
    // Well-formed snapshot
    const good={feature:null,mission,tasks:[{file:tp,line:3,text:"A",done:false}],capturedAt:new Date().toISOString()};
    // Contract: a valid snapshot returns {ok:true} WITH tasks equal to snapshot.tasks.
    // Fails when the validator is reverted to a bare {ok:true} (no tasks).
    {
      const r=validateStandaloneSnapshot(good,mission,tp);
      check("validateStandaloneSnapshot: valid returns tasks",r.ok===true&&Array.isArray(r.tasks)&&isDeepStrictEqual(r.tasks,good.tasks),r);
    }
    // feature not null
    const badFeature={...good,feature:"specs/x"};
    check("validateStandaloneSnapshot: feature not null",!validateStandaloneSnapshot(badFeature,mission,tp).ok);
    // missing capturedAt
    {
      const {capturedAt: _drop, ...noCaptured}=good;
      const r=validateStandaloneSnapshot(noCaptured,mission,tp);
      check("validateStandaloneSnapshot: missing capturedAt",r.ok===false&&r.reason==="standalone snapshot is missing capturedAt",r);
      const emptyCaptured={...good,capturedAt:""};
      const r2=validateStandaloneSnapshot(emptyCaptured,mission,tp);
      check("validateStandaloneSnapshot: empty capturedAt",r2.ok===false&&r2.reason==="standalone snapshot is missing capturedAt",r2);
    }
    // missing mission
    {
      const {mission: _drop, ...noMission}=good;
      const r=validateStandaloneSnapshot(noMission,mission,tp);
      check("validateStandaloneSnapshot: missing mission",r.ok===false&&r.reason==="standalone snapshot is missing a valid mission identity",r);
    }
    // mission mismatch
    const badMission={...good,mission:"wrong"};
    check("validateStandaloneSnapshot: mission mismatch",!validateStandaloneSnapshot(badMission,mission,tp).ok);
    // empty or malformed task list
    {
      const emptyTasks={...good,tasks:[]};
      const r=validateStandaloneSnapshot(emptyTasks,mission,tp);
      check("validateStandaloneSnapshot: empty task list",r.ok===false&&r.reason==="standalone snapshot tasks is not a non-empty array",r);
      const noTasks={feature:null,mission,capturedAt:good.capturedAt};
      const r2=validateStandaloneSnapshot(noTasks,mission,tp);
      check("validateStandaloneSnapshot: missing task list",r2.ok===false&&r2.reason==="standalone snapshot tasks is not a non-empty array",r2);
      const malformedEntry={...good,tasks:[{file:tp,line:3,done:false}]};
      const r3=validateStandaloneSnapshot(malformedEntry,mission,tp);
      check("validateStandaloneSnapshot: malformed task entry (missing text)",r3.ok===false,r3);
      const badLine={...good,tasks:[{file:tp,line:0,text:"A",done:false}]};
      check("validateStandaloneSnapshot: malformed task entry (bad line)",!validateStandaloneSnapshot(badLine,mission,tp).ok);
      const badDone={...good,tasks:[{file:tp,line:3,text:"A",done:"no"}]};
      check("validateStandaloneSnapshot: malformed task entry (bad done)",!validateStandaloneSnapshot(badDone,mission,tp).ok);
      const badFile={...good,tasks:[{file:"",line:3,text:"A",done:false}]};
      check("validateStandaloneSnapshot: malformed task entry (bad file)",!validateStandaloneSnapshot(badFile,mission,tp).ok);
    }
    // tasks escapes repo
    const badEscape={...good,tasks:[{file:"/etc/passwd",line:1,text:"x",done:false}]};
    check("validateStandaloneSnapshot: task escapes repo",!validateStandaloneSnapshot(badEscape,mission,tp).ok);
    // null/undefined/malformed
    check("validateStandaloneSnapshot: null",!validateStandaloneSnapshot(null,mission,tp).ok);
    check("validateStandaloneSnapshot: undefined",!validateStandaloneSnapshot(undefined,mission,tp).ok);
    check("validateStandaloneSnapshot: array",!validateStandaloneSnapshot([],mission,tp).ok);
    // Snapshot referencing another mission's TASKS.md (exact-match required)
    const otherMission="other-mission";
    const otherTp=standalone.tasksPath(repo,otherMission);
    const crossMission={feature:null,mission,tasks:[{file:otherTp,line:3,text:"X",done:false}],capturedAt:new Date().toISOString()};
    check("validateStandaloneSnapshot: other mission TASKS.md rejected",!validateStandaloneSnapshot(crossMission,mission,tp).ok);
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §8 Declared ignored visible vs undeclared hidden in scopedDelta
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const key="ignored-vis";
    const mission="ign-m";
    // Create an ignored file and a declared (gitignored) deliverable
    fs.writeFileSync(path.join(repo,".gitignore"),"ignored/\ndist/\n");
    fs.mkdirSync(path.join(repo,"ignored"),{recursive:true});
    fs.writeFileSync(path.join(repo,"ignored","data.log"),"old content");
    fs.mkdirSync(path.join(repo,"dist"),{recursive:true});
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// v1");
    ensureBaseline(repo,key,{mission,declaredPaths:["dist/out.js"]});
    // Change both: ignored file changes AND declared file changes
    fs.writeFileSync(path.join(repo,"ignored","data.log"),"new content");
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// v2");
    const delta=scopedDelta(repo,key,{mission,declaredPaths:["dist/out.js"]});
    check("declared ignored visible: delta contains declared change",delta.includes("out.js"));
    // Gitignored untracked file is invisible to git status → not in delta
    check("declared ignored visible: gitignored untracked file not in delta",!delta.includes("data.log"));
    // Now without declaring: ignored change hidden, declared still visible if it was gitignored
    ensureBaseline(repo,key+"-no-decl",{mission,declaredPaths:[]});
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// v3");
    const deltaNoDecl=scopedDelta(repo,key+"-no-decl",{mission,declaredPaths:[]});
    check("undeclared hidden: gitignored dist/out.js not in delta without declaration",!deltaNoDecl.includes("out.js"));
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §9 Worktree entries (listWorktreeEntries)
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const entries=listWorktreeEntries(repo);
    check("listWorktreeEntries: returns array",Array.isArray(entries));
    check("listWorktreeEntries: contains README.md",entries.includes("README.md"));
    check("listWorktreeEntries: excludes .git",!entries.includes(".git"));
    check("listWorktreeEntries: excludes .autopilot",!entries.includes(".autopilot"));
    // Empty directory shows with trailing /
    fs.mkdirSync(path.join(repo,"emptydir"));
    const entries2=listWorktreeEntries(repo);
    check("listWorktreeEntries: empty dir has trailing /",entries2.includes("emptydir/"));
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §10 sanitizeKeySegment
// ═══════════════════════════════════════════════════════════════════
{
  check("sanitizeKeySegment: normal",sanitizeKeySegment("my-mission")==="my-mission");
  check("sanitizeKeySegment: special chars",sanitizeKeySegment("my/mission\\is:great")==="my_mission_is_great");
  check("sanitizeKeySegment: empty",sanitizeKeySegment("")!=="");
  check("sanitizeKeySegment: dot",sanitizeKeySegment(".")!=="."&&sanitizeKeySegment(".")!=="..");
}

// ═══════════════════════════════════════════════════════════════════
// §11 Scoped delta markers
// ═══════════════════════════════════════════════════════════════════
{
  check("scopedDeltaBeginMarker PHASE",scopedDeltaBeginMarker("PHASE")==="<<<AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE>>>");
  check("scopedDeltaBeginMarker MISSION",scopedDeltaBeginMarker("MISSION")==="<<<AUTOPILOT_SCOPED_DELTA_BEGIN:MISSION>>>");
  check("SCOPED_DELTA_END_MARKER",SCOPED_DELTA_END_MARKER==="<<<AUTOPILOT_SCOPED_DELTA_END>>>");
}

// ═══════════════════════════════════════════════════════════════════
// §12 Dirty declared vs snapshot
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    const key="dirty-decl";
    const mission="dd-m";
    fs.mkdirSync(path.join(repo,"dist"),{recursive:true});
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// v1");
    ensureBaseline(repo,key,{mission,declaredPaths:["dist/out.js"]});
    // Snapshot is clean (baseline captured "v1")
    const delta0=scopedDelta(repo,key,{mission,declaredPaths:["dist/out.js"]});
    check("dirty declared: no change = empty delta",delta0.trim()==="");
    // Modify declared file
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// v2");
    const delta1=scopedDelta(repo,key,{mission,declaredPaths:["dist/out.js"]});
    check("dirty declared: change = non-empty delta",delta1.includes("out.js"));
    // Revert to snapshot content
    fs.writeFileSync(path.join(repo,"dist","out.js"),"// v1");
    const delta2=scopedDelta(repo,key,{mission,declaredPaths:["dist/out.js"]});
    check("dirty declared: revert = empty delta",delta2.trim()==="");
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §13 Non-existent baseline key: no crash, returns empty (clean worktree)
// ═══════════════════════════════════════════════════════════════════
{
  const repo=makeRepo();
  try{
    // scopedDelta on non-existent baseline: returns empty if worktree is clean
    // (no manifest, no status entries, nothing to diff)
    const delta=scopedDelta(repo,"nonexistent-key");
    check("nonexistent baseline: scopedDelta returns empty string (clean worktree)",delta.trim()==="",delta);
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

// ═══════════════════════════════════════════════════════════════════
// §14 Historical baseline migration preconditions
// ═══════════════════════════════════════════════════════════════════
{
  // Tests the three preconditions for safe retroactive baseline creation:
  //   1. baseline does NOT exist
  //   2. ALL tasks are undone (every t.done===false)
  //   3. NO pending checkbox snapshot
  // If all hold → baseline can be created safely. Otherwise → MIGRATION_BASELINE_MISSING.
  const repo=makeRepo();
  try{
    const mission="mig-test";
    const key="mission-mig-test";
    const baselinePath=path.join(repo,".autopilot","baseline",key);
    writeTasks(repo,mission,`## Phase 1\n\n- [ ] Task A\n- [ ] Task B\n`);
    const items=standalone.tasks(repo,mission);
    // Safe: no baseline, all undone, no snapshot
    check("migration: no baseline = exists false",!fs.existsSync(path.join(baselinePath,"manifest.json")));
    const allUndone=items.every(t=>!t.done);
    check("migration: all undone",allUndone);
    // Now create baseline (simulating the safe path)
    const declaredPaths=standalone.declaredDeliverables(repo,mission);
    ensureBaseline(repo,key,{mission,declaredPaths});
    check("migration: baseline now exists",fs.existsSync(path.join(baselinePath,"manifest.json")));
    // Unsafe: baseline exists → condition fails (migration not needed)
    const stillExists=fs.existsSync(path.join(baselinePath,"manifest.json"));
    check("migration: second call would see baseline exists (no double-create)",stillExists);
    // Unsafe: task done → allUndone=false
    const tp=standalone.tasksPath(repo,mission);
    const tasks=standalone.tasks(repo,mission);
    const {applyTaskCheckboxStates}=await import("./speckit-task-state.mjs");
    applyTaskCheckboxStates(tasks.map(t=>({...t,done:true})));
    const afterDone=standalone.tasks(repo,mission);
    const someDone=afterDone.some(t=>t.done);
    check("migration: done task → someDone=true (blocks migration)",someDone);
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}

console.log(`\n${ok} passed, ${failed} failed`);
if(failed) process.exit(1);
