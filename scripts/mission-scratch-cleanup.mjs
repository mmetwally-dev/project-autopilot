// Deletes the per-run `scratch` directories of ONE finished mission.
// Only <missionDir>/runs/<run-id>/scratch (direct children named "scratch")
// are removed; every other file is left alone. Symlinks are never followed.
import fs from "node:fs";
import path from "node:path";

function dirBytes(p){
  let st;
  try{st=fs.lstatSync(p)}catch{return 0}
  if(st.isSymbolicLink()||!st.isDirectory()) return st.size||0;
  let entries=[];
  try{entries=fs.readdirSync(p)}catch{return 0}
  let total=0;
  for(const e of entries) total+=dirBytes(path.join(p,e));
  return total;
}

export function cleanMissionScratch(missionDir){
  const out={removed:0,bytes:0};
  const runsDir=path.resolve(missionDir,"runs");
  let runs;
  try{runs=fs.readdirSync(runsDir,{withFileTypes:true})}catch{return out}
  for(const run of runs){
    if(!run.isDirectory()) continue;
    const runDir=path.join(runsDir,run.name);
    const target=path.join(runDir,"scratch");
    if(path.dirname(path.resolve(runDir))!==runsDir||path.dirname(path.resolve(target))!==path.resolve(runDir)) continue;
    let st;
    try{st=fs.lstatSync(target)}catch{continue}
    try{
      if(st.isSymbolicLink()){fs.unlinkSync(target);out.removed++;continue}
      if(!st.isDirectory()) continue;
      const bytes=dirBytes(target);
      fs.rmSync(target,{recursive:true,force:true});
      out.removed++;out.bytes+=bytes;
    }catch(e){console.warn(`Warning: scratch cleanup failed for ${target}: ${e.message}`)}
  }
  return out;
}
