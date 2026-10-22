#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const run=(cwd,args,input)=>spawnSync("git",args,{cwd,encoding:"utf8",input,env:withoutOuterGitGuard(process.env),shell:false});
const out=(cwd,args)=>{const r=run(cwd,args);if(r.status!==0)throw new Error((r.stderr||r.stdout||"").trim());return (r.stdout||"").trimEnd();};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"autopilot-gsd-wave-"));
try{
  out(tmp,["init"]);
  out(tmp,["config","user.email","test@example.com"]);
  out(tmp,["config","user.name","Autopilot Test"]);
  fs.writeFileSync(path.join(tmp,"app.txt"),"base\n");
  out(tmp,["add","app.txt"]); out(tmp,["commit","-m","base"]);
  const baseSha=out(tmp,["rev-parse","HEAD"]);

  // Wave 1 changes the working tree without creating a commit, matching
  // Autopilot's no-commit execution model.
  fs.writeFileSync(path.join(tmp,"app.txt"),"base\nwave1\n");
  const wave1Snapshot=out(tmp,["diff","--binary","HEAD","--","app.txt"])+"\n";

  // Simulate the next-wave baseline: same commit, but a fresh snapshot that
  // includes Wave 1. This is exactly what executeWave now captures per wave.
  const wave2BaseSha=out(tmp,["rev-parse","HEAD"]);
  if(wave2BaseSha!==baseSha)throw new Error("Unexpected commit change during no-commit wave execution");
  const snapshot2=out(tmp,["diff","--binary","HEAD","--","app.txt"])+"\n";
  if(!snapshot2.includes("wave1"))throw new Error("Wave 2 snapshot did not include Wave 1 changes");

  // Build a Wave 2 patch the same way the implementation does: compare the
  // current main file (already containing Wave 1) with the isolated worktree
  // file (Wave 1 + Wave 2). This must produce a Wave-2-only delta.
  const wave2File=path.join(tmp,"app.txt");
  const worktree=fs.mkdtempSync(path.join(os.tmpdir(),"autopilot-gsd-worktree-"));
  try{
    fs.copyFileSync(wave2File,path.join(worktree,"app.txt"));
    fs.writeFileSync(path.join(worktree,"app.txt"),"base\nwave1\nwave2\n");
    const r=spawnSync("git",["diff","--no-index","--binary","--",wave2File,path.join(worktree,"app.txt")],{cwd:tmp,encoding:"utf8",env:withoutOuterGitGuard(process.env),shell:false});
    if(r.status!==1)throw new Error("Expected git diff --no-index to report a Wave 2 change");
    let patch=r.stdout||"";
    const lines=patch.split(/\n/).map(line=>{
      if(line.startsWith("diff --git ")) return "diff --git a/app.txt b/app.txt";
      if(line.startsWith("--- ")) return "--- a/app.txt";
      if(line.startsWith("+++ ")) return "+++ b/app.txt";
      return line;
    });
    patch=lines.join("\n");
    if(!patch.includes("+wave2") || patch.includes("+wave1\n+wave2")){
      throw new Error("Wave 2 patch unexpectedly re-encoded Wave 1 changes");
    }

    // Validate/apply the Wave 2 delta against a repo whose working tree already
    // contains Wave 1, which is the post-Wave-1 state the orchestrator sees.
    const validationRepo=fs.mkdtempSync(path.join(os.tmpdir(),"autopilot-gsd-validate-"));
    try{
      out(validationRepo,["init"]); out(validationRepo,["config","user.email","test@example.com"]); out(validationRepo,["config","user.name","Autopilot Test"]);
      fs.writeFileSync(path.join(validationRepo,"app.txt"),"base\n");
      out(validationRepo,["add","app.txt"]); out(validationRepo,["commit","-m","base"]);
      fs.writeFileSync(path.join(validationRepo,"app.txt"),"base\nwave1\n");
      const check=run(validationRepo,["apply","--check","--whitespace=nowarn","-"],patch);
      if(check.status!==0)throw new Error(`Wave 2 patch failed validation on Wave 1 state: ${(check.stderr||check.stdout||"").trim()}`);
    } finally { fs.rmSync(validationRepo,{recursive:true,force:true}); }
  } finally { fs.rmSync(worktree,{recursive:true,force:true}); }

  console.log("GSD wave regression: PASS");
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
