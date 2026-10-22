import fs from "node:fs";
import path from "node:path";
import {parseGsdRequirements} from "../scripts/role-requirements.mjs";
import {deriveTaskFacts} from "../scripts/task-requirements.mjs";

export function detect(repo) {
  return fs.existsSync(path.join(repo,".planning","ROADMAP.md")) &&
         fs.existsSync(path.join(repo,".planning","STATE.md"));
}

function scalar(text, key) {
  const m=text.match(new RegExp(`^${key}:\\s*(.+)$`,"mi"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g,"") : "";
}
function yamlList(text,key){
  const m=text.match(new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`,"mi"));
  if(!m)return [];
  return m[1].split(",").map(x=>x.trim().replace(/^['"]|['"]$/g,"")).filter(Boolean);
}
function tagValue(text, tag){
  const m=text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function listBlocks(text, tag){
  const re=new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  const out=[]; let m;
  while((m=re.exec(text))) out.push(m[1].trim());
  return out;
}
function parseTaskBlocks(text){
  return listBlocks(text,"task").map(block => ({
    name:tagValue(block,"name"),
    files:listBlocks(block,"files").flatMap(x=>x.split(/\r?\n|,/).map(v=>v.trim()).filter(Boolean)),
    action:tagValue(block,"action"),
    verify:tagValue(block,"verify"),
    done:tagValue(block,"done"),
    requiredCapabilities:parseGsdRequirements(block),
    raw:block
  }));
}

export function parsePlan(file){
  const text=fs.readFileSync(file,"utf8");
  const fm=text.match(/^---\n([\s\S]*?)\n---/);
  const frontText=fm?.[1]||"";
  const phase=scalar(frontText,"phase");
  const plan=scalar(frontText,"plan");
  const type=scalar(frontText,"type")||"execute";
  const wave=Number(scalar(frontText,"wave"))||1;
  const depends_on=yamlList(frontText,"depends_on");
  const files_modified=yamlList(frontText,"files_modified");
  return {
    file,
    id:path.basename(file),
    phase,
    plan,
    type,
    wave,
    depends_on,
    files_modified,
    objective:tagValue(text,"objective"),
    tasks:parseTaskBlocks(text)
  };
}

export function inspect(repo,phaseRoot){
  const base=path.join(repo,".planning");
  const artifacts=["PROJECT.md","config.json","REQUIREMENTS.md","ROADMAP.md","STATE.md"]
    .filter(f=>fs.existsSync(path.join(base,f)));
  const root=phaseRoot?path.resolve(repo,phaseRoot):path.join(base,"phases");
  const phases=[];
  if(fs.existsSync(root)){
    for(const d of fs.readdirSync(root,{withFileTypes:true})){ 
      if(!d.isDirectory())continue;
      const dir=path.join(root,d.name);
      const files=fs.readdirSync(dir);
      const plans=files.filter(f=>/-PLAN\.md$/i.test(f)).map(f=>parsePlan(path.join(dir,f)));
      const verification=files.some(f=>/^VERIFICATION\.md$/i.test(f)||/-VERIFICATION\.md$/i.test(f));
      const uat=files.some(f=>/^UAT\.md$/i.test(f)||/-UAT\.md$/i.test(f));
      const summary=files.some(f=>/-SUMMARY\.md$/i.test(f)||/^SUMMARY\.md$/i.test(f));
      phases.push({id:d.name,files,plans,planned:plans.length>0,executed:summary,verified:verification,uat});
    }
  }
  return {id:"gsd",detected:detect(repo),artifacts,phases,phaseRoot:phaseRoot||".planning/phases",phaseModel:["discuss","plan","execute","verify","ship"]};
}

export function currentPhase(repo,phaseRoot){
  return inspect(repo,phaseRoot).phases.find(p=>p.planned && !p.verified)?.id || null;
}
export function phasePlans(repo,phaseId,phaseRoot){
  return inspect(repo,phaseRoot).phases.find(p=>p.id===phaseId)?.plans || [];
}
export function normalizedTasks(repo,phaseId,phaseRoot){
  return phasePlans(repo,phaseId,phaseRoot).flatMap(plan=>plan.tasks.map((task,idx)=>({
    planFile:plan.file,
    planId:plan.id,
    wave:plan.wave||1,
    depends_on:plan.depends_on||[],
    files_modified:plan.files_modified||[],
    taskIndex:idx,
    name:task.name||`task-${idx+1}`,
    files:task.files.length?task.files:plan.files_modified||[],
    action:task.action,
    verify:task.verify,
    done:task.done,
    requiredCapabilities:task.requiredCapabilities,
    taskFacts:deriveTaskFacts({files:task.files.length?task.files:plan.files_modified||[],verify:task.verify,requiredCapabilities:task.requiredCapabilities}),
    rawTask:task.raw
  })));
}
export function phaseSummary(repo,phaseId,phaseRoot){return inspect(repo,phaseRoot).phases.find(p=>p.id===phaseId)||null;}
export function nextPendingPhase(repo,afterId=null,phaseRoot){
  const phases=inspect(repo,phaseRoot).phases;
  const start=afterId?Math.max(-1,phases.findIndex(p=>p.id===afterId)):-1;
  return phases.slice(start+1).find(p=>p.planned&&!p.verified)?.id||null;
}
