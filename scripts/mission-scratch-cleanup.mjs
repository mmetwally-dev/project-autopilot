// Deletes the per-run `scratch` directories of ONE finished mission and applies
// browser artifact retention (backlog #7):
//   - Only <missionDir>/runs/<run-id>/scratch (direct children named "scratch")
//     are removed when the mission finishes; before removing a verifier run's
//     scratch, any `browser-check/` artifacts not yet copied to
//     <runDir>/browser-check/ are preserved there.
//   - Browser artifact retention (`cleanBrowserArtifacts`, also invoked inside
//     `cleanMissionScratch`):
//       * screenshots (`.png`) are ALWAYS kept (small proof)
//       * browser videos (`.webm`, `.mp4`) and Playwright traces (`.zip`) are
//         kept ONLY for the LAST verifier run of each phase and for FAILED
//         verifier runs (deleted immediately for earlier non-failed verifier
//         runs of the same phase)
//       * all browser videos and traces older than 3 days (72 hours after they
//         were recorded, whether or not the mission has ended) are deleted
//         automatically.
//   - Symlinks are never followed.
import fs from "node:fs";
import path from "node:path";

export const BROWSER_MEDIA_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const BROWSER_CHECK_DIR = "browser-check";

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

function isVideoOrTraceFile(name){
  const lower=String(name||"").toLowerCase();
  return lower.endsWith(".zip")||lower.endsWith(".webm")||lower.endsWith(".mp4");
}

function parseRunSeq(runName){
  const m=/^(\d+)-/.exec(String(runName||""));
  return m?Number(m[1]):0;
}

function readJsonSafe(filePath){
  try{
    if(!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath,"utf8"));
  }catch{
    return null;
  }
}

function parseTimestampMs(val){
  if(typeof val==="number"&&Number.isFinite(val)) return val;
  if(typeof val==="string"&&val){
    const t=Date.parse(val);
    if(Number.isFinite(t)) return t;
  }
  return null;
}

// Rescue `<runDir>/scratch/browser-check/*` into `<runDir>/browser-check/*`
// before `<runDir>/scratch` is removed, so screenshots/evidence survive scratch
// deletion. Never follows symlinks.
function preserveBrowserCheckFromScratch(runDir){
  const srcDir=path.join(runDir,"scratch",BROWSER_CHECK_DIR);
  let st;
  try{st=fs.lstatSync(srcDir)}catch{return}
  if(st.isSymbolicLink()||!st.isDirectory()) return;
  const dstDir=path.join(runDir,BROWSER_CHECK_DIR);
  try{
    fs.mkdirSync(dstDir,{recursive:true});
    for(const entry of fs.readdirSync(srcDir,{withFileTypes:true})){
      const srcFile=path.join(srcDir,entry.name);
      const dstFile=path.join(dstDir,entry.name);
      let fst;
      try{fst=fs.lstatSync(srcFile)}catch{continue}
      if(fst.isSymbolicLink()||!fst.isFile()) continue;
      if(!fs.existsSync(dstFile)){
        fs.copyFileSync(srcFile,dstFile);
        try{fs.utimesSync(dstFile,fst.atime,fst.mtime)}catch{}
      }
    }
  }catch{}
}

// Applies browser artifact retention across one mission directory (whether or
// not the mission has ended). Returns {deletedFiles, bytes}.
export function cleanBrowserArtifacts(missionDir,{nowMs=Date.now(),maxAgeMs=BROWSER_MEDIA_RETENTION_MS}={}){
  const out={deletedFiles:0,bytes:0};
  if(typeof missionDir!=="string"||!missionDir) return out;
  const runsDir=path.resolve(missionDir,"runs");
  let entries;
  try{entries=fs.readdirSync(runsDir,{withFileTypes:true})}catch{return out}

  const verifierRuns=[];
  for(const entry of entries){
    if(!entry.isDirectory()) continue;
    const runDir=path.join(runsDir,entry.name);
    if(path.dirname(path.resolve(runDir))!==runsDir) continue;
    let lst;
    try{lst=fs.lstatSync(runDir)}catch{continue}
    if(lst.isSymbolicLink()||!lst.isDirectory()) continue;

    const status=readJsonSafe(path.join(runDir,"status.json"));
    const result=readJsonSafe(path.join(runDir,"result.json"));
    const role=result?.role||status?.role||(entry.name.includes("-verifier-")?"verifier":null);
    const hasBrowserCheck=fs.existsSync(path.join(runDir,BROWSER_CHECK_DIR))||fs.existsSync(path.join(runDir,"scratch",BROWSER_CHECK_DIR));
    if(role!=="verifier"&&!hasBrowserCheck) continue;

    const phase=String(result?.phase??status?.phase??"default");
    const decision=result?.review?.decision??result?.verdict?.decision??status?.decision??null;
    const runStatus=result?.status??status?.status??null;
    const evidence=readJsonSafe(path.join(runDir,BROWSER_CHECK_DIR,"evidence.json"))
      ||readJsonSafe(path.join(runDir,"scratch",BROWSER_CHECK_DIR,"evidence.json"));
    const wrapperFailed=typeof evidence?.exitCode==="number"&&evidence.exitCode!==0;
    const isFailedRun=decision==="FAIL"||runStatus==="failed"||wrapperFailed;
    const recordedMs=parseTimestampMs(evidence?.recordedAt)
      ??parseTimestampMs(result?.finishedAt)
      ??parseTimestampMs(status?.updated_at)
      ??parseTimestampMs(status?.started_at)
      ??lst.mtimeMs;

    verifierRuns.push({
      name:entry.name,
      seq:parseRunSeq(entry.name),
      runDir,
      phase,
      isFailedRun,
      recordedMs,
    });
  }

  // Group by phase and find the last verifier run of each phase (by sequence
  // number, tie-broken by recordedMs / name).
  const lastRunByPhase=new Map();
  for(const r of verifierRuns){
    const prev=lastRunByPhase.get(r.phase);
    if(!prev||r.seq>prev.seq||(r.seq===prev.seq&&r.recordedMs>prev.recordedMs)||(r.seq===prev.seq&&r.recordedMs===prev.recordedMs&&r.name>prev.name)){
      lastRunByPhase.set(r.phase,r);
    }
  }

  for(const r of verifierRuns){
    const isLastOfPhase=lastRunByPhase.get(r.phase)===r;
    const keepForRunOutcome=isLastOfPhase||r.isFailedRun;

    for(const dirCandidate of [path.join(r.runDir,BROWSER_CHECK_DIR),path.join(r.runDir,"scratch",BROWSER_CHECK_DIR)]){
      let dst;
      try{dst=fs.lstatSync(dirCandidate)}catch{continue}
      if(dst.isSymbolicLink()||!dst.isDirectory()) continue;
      let files=[];
      try{files=fs.readdirSync(dirCandidate,{withFileTypes:true})}catch{continue}
      for(const f of files){
        const full=path.join(dirCandidate,f.name);
        let fst;
        try{fst=fs.lstatSync(full)}catch{continue}
        if(fst.isSymbolicLink()||!fst.isFile()) continue;
        // Screenshots (.png), script copies, output.log and evidence.json are
        // ALWAYS kept. Only videos (.webm/.mp4) and traces (.zip) are subject
        // to the retention pruning.
        if(!isVideoOrTraceFile(f.name)) continue;

        const fileRecordedMs=Number.isFinite(fst.mtimeMs)?fst.mtimeMs:r.recordedMs;
        const ageMs=nowMs-Math.min(r.recordedMs||fileRecordedMs,fileRecordedMs);
        const expired=Number.isFinite(ageMs)&&ageMs>=maxAgeMs;
        if(!keepForRunOutcome||expired){
          try{
            const sz=fst.size||0;
            fs.unlinkSync(full);
            out.deletedFiles++;
            out.bytes+=sz;
          }catch{}
        }
      }
    }
  }
  return out;
}

// Sweep browser artifacts across ALL missions under `<repo>/.autopilot/missions`
// (whether or not a mission has ended) so videos and traces older than 3 days
// are deleted automatically.
export function cleanAllMissionsBrowserArtifacts(repo,{nowMs=Date.now(),maxAgeMs=BROWSER_MEDIA_RETENTION_MS}={}){
  const total={deletedFiles:0,bytes:0};
  if(typeof repo!=="string"||!repo) return total;
  const missionsRoot=path.resolve(repo,".autopilot","missions");
  let entries=[];
  try{entries=fs.readdirSync(missionsRoot,{withFileTypes:true})}catch{return total}
  for(const entry of entries){
    if(!entry.isDirectory()) continue;
    const mDir=path.join(missionsRoot,entry.name);
    let lst;
    try{lst=fs.lstatSync(mDir)}catch{continue}
    if(lst.isSymbolicLink()||!lst.isDirectory()) continue;
    const r=cleanBrowserArtifacts(mDir,{nowMs,maxAgeMs});
    total.deletedFiles+=r.deletedFiles;
    total.bytes+=r.bytes;
  }
  return total;
}

export function cleanMissionScratch(missionDir,{nowMs=Date.now(),maxAgeMs=BROWSER_MEDIA_RETENTION_MS}={}){
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
      preserveBrowserCheckFromScratch(runDir);
      const bytes=dirBytes(target);
      fs.rmSync(target,{recursive:true,force:true});
      out.removed++;out.bytes+=bytes;
    }catch(e){console.warn(`Warning: scratch cleanup failed for ${target}: ${e.message}`)}
  }
  try{
    const b=cleanBrowserArtifacts(missionDir,{nowMs,maxAgeMs});
    out.bytes+=b.bytes;
  }catch{}
  try{
    const parent=path.dirname(path.resolve(missionDir));
    if(path.basename(parent)==="missions"){
      let siblings=[];
      try{siblings=fs.readdirSync(parent,{withFileTypes:true})}catch{}
      for(const sib of siblings){
        if(!sib.isDirectory()) continue;
        const sibDir=path.join(parent,sib.name);
        if(path.resolve(sibDir)===path.resolve(missionDir)) continue;
        let lst;
        try{lst=fs.lstatSync(sibDir)}catch{continue}
        if(lst.isSymbolicLink()||!lst.isDirectory()) continue;
        cleanBrowserArtifacts(sibDir,{nowMs,maxAgeMs});
      }
    }
  }catch{}
  return out;
}
