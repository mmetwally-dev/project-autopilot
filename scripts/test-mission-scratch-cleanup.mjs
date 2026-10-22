#!/usr/bin/env node
// Tests for cleanMissionScratch (success-only per-run scratch cleanup).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {cleanMissionScratch} from "./mission-scratch-cleanup.mjs";

let passed=0;
const t=(name,fn)=>{fn();passed++;};
const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"scratch-clean-"));
const w=(p,c="x")=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,c)};

try{
  const mission=path.join(tmp,"001-m");
  const keep=["status.json","result.json","stdout.log","WATCH-REPORT.md"];
  for(const id of ["r1","r2","r3"]){
    const run=path.join(mission,"runs",id);
    for(const f of keep) w(path.join(run,f),id);
    w(path.join(run,"scratch","a.bin"),"a".repeat(1000));
    w(path.join(run,"scratch","deep","b.bin"),"b".repeat(500));
  }
  w(path.join(mission,"runs","r1","sub","scratch","keep.txt"));
  w(path.join(mission,"scratch","keep.txt"));
  w(path.join(mission,"runs","stray-file"));
  const outside=path.join(tmp,"outside");
  w(path.join(outside,"precious.txt"),"keep me");
  fs.symlinkSync(outside,path.join(mission,"runs","r4-link-scratch-parent"),"dir");
  const r5=path.join(mission,"runs","r5");
  w(path.join(r5,"status.json"));
  fs.symlinkSync(outside,path.join(r5,"scratch"),"dir");

  const res=cleanMissionScratch(mission);
  t("counts",()=>{assert.equal(res.removed,4);assert.ok(res.bytes>=4500)});
  t("scratch removed",()=>{for(const id of ["r1","r2","r3","r5"]) assert.ok(!fs.existsSync(path.join(mission,"runs",id,"scratch")))});
  t("other files kept",()=>{for(const id of ["r1","r2","r3"]) for(const f of keep) assert.equal(fs.readFileSync(path.join(mission,"runs",id,f),"utf8"),id);assert.ok(fs.existsSync(path.join(r5,"status.json")))});
  t("wrong-place scratch untouched",()=>{
    assert.ok(fs.existsSync(path.join(mission,"runs","r1","sub","scratch","keep.txt")));
    assert.ok(fs.existsSync(path.join(mission,"scratch","keep.txt")));
    assert.ok(fs.existsSync(path.join(mission,"runs","stray-file")));
  });
  t("symlink target never deleted",()=>assert.equal(fs.readFileSync(path.join(outside,"precious.txt"),"utf8"),"keep me"));
  t("missing runs dir",()=>assert.deepEqual(cleanMissionScratch(path.join(tmp,"nope")),{removed:0,bytes:0}));
  t("idempotent",()=>assert.equal(cleanMissionScratch(mission).removed,0));

  const src=fs.readFileSync(path.join(here,"autopilot.mjs"),"utf8");
  t("called exactly once, inside finalizeMissionComplete",()=>{
    const calls=[...src.matchAll(/cleanMissionScratch\(/g)];
    assert.equal(calls.length,1);
    const start=src.indexOf("function finalizeMissionComplete(");
    const end=src.indexOf("\n}\n",start);
    assert.ok(start>0&&calls[0].index>start&&calls[0].index<end);
    const body=src.slice(start,end);
    assert.ok(body.indexOf('s.phase="complete"')<calls[0].index-start);
    assert.ok(!/process\.on\(\s*["']exit/.test(src.slice(start,end)));
  });
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
console.log(`${passed} passed`);
