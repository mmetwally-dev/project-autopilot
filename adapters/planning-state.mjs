import fs from "node:fs";
import path from "node:path";

const exists=(repo,p)=>fs.existsSync(path.join(repo,p));
const read=(repo,p)=>exists(repo,p)?fs.readFileSync(path.join(repo,p),"utf8"):"";
const walk=(root,out=[])=>{
  if(!fs.existsSync(root)) return out;
  for(const e of fs.readdirSync(root,{withFileTypes:true})){
    const p=path.join(root,e.name);
    if(e.isDirectory()) walk(p,out); else out.push(p);
  }
  return out;
};
const basename=p=>path.basename(p).toLowerCase();

export function specKitState(repo,info,candidates=[]){
  const files=walk(path.join(repo,"specs"));
  const extra=[".specify/spec.md",".specify/plan.md",".specify/tasks.md"]
    .filter(p=>exists(repo,p)).map(p=>path.join(repo,p));
  const all=[...new Set([...files,...extra])];
  const norm=p=>p.replaceAll("\\","/").toLowerCase();
  const hasSpec=all.some(p=>/(^|\/)(spec|specification)\.md$/.test(norm(p)));
  const hasPlan=all.some(p=>/(^|\/)(plan|planning)\.md$/.test(norm(p)));
  const taskFiles=[];
  for(const f of candidates){
    if(!f.includes("*")){ if(exists(repo,f)) taskFiles.push(path.join(repo,f)); continue; }
    const root=path.join(repo,f.split("*")[0]);
    if(fs.existsSync(root)) walk(root).filter(x=>basename(x).includes("tasks")&&x.toLowerCase().endsWith(".md")).forEach(x=>taskFiles.push(x));
  }
  const uniqueTasks=[...new Set(taskFiles)];
  const hasTasks=uniqueTasks.some(f=>{const t=fs.readFileSync(f,"utf8");return /(?:^|\n)\s*-\s*\[[ xX]\]/.test(t)||/\btask\b/i.test(t)&&t.trim().length>40;});
  const steps=info.steps||[];
  const commandStages=steps.map((s,i)=>({step:s,index:i})).filter(x=>/(spec|plan|task)/i.test(x.step.id)&&!/(review|gate)/i.test(x.step.id));
  let entryIndex=0;
  if(hasSpec && hasPlan && hasTasks){ entryIndex=steps.length; }
  else if(hasPlan){
    const taskStep=commandStages.find(x=>/task/i.test(x.step.id));
    entryIndex=taskStep?.index ?? steps.length;
  }
  else if(hasSpec){
    const planStep=commandStages.find(x=>/plan/i.test(x.step.id));
    entryIndex=planStep?.index ?? steps.length;
  }
  let logicalState="missing";
  if(hasSpec && hasPlan && hasTasks) logicalState="complete";
  else if(hasSpec||hasPlan||hasTasks) logicalState="partial";
  else logicalState="missing";
  return {
    framework:"speckit",
    status:logicalState,
    entryIndex,
    evidence:{spec:hasSpec,plan:hasPlan,tasks:hasTasks},
    taskFiles:uniqueTasks,
    requiresValidation:logicalState!=="missing",
    confidence:logicalState==="complete"?"high":"medium",
    reason:logicalState==="complete"?"spec, plan, and tasks artifacts detected":logicalState==="partial"?"one or more planning artifacts already exist":logicalState==="ambiguous"?"workflow exists but no recognizable planning artifacts were found":"no planning artifacts detected"
  };
}

function phaseEvidence(repo,phase){
  const dir=phase.dir;
  const files=fs.readdirSync(dir);
  const research=files.some(f=>/^RESEARCH\.md$/i.test(f)||/-RESEARCH\.md$/i.test(f));
  const plans=phase.plans||[];
  const planComplete=plans.length>0 && plans.every(p=>p.tasks?.length>0);
  const verified=phase.verified;
  const summary=phase.executed;
  return {research,plan:planComplete,plans:plans.length,verified,summary};
}

function roadmapPhaseIds(repo){
  const text=read(repo,".planning/ROADMAP.md");
  const ids=[]; const seen=new Set();
  const patterns=[
    /^#{1,4}\s*Phase\s+(\d+(?:\.\d+)?)\b/gmi,
    /^\s*[-*]\s*\[[ xX]\]\s*(?:Phase\s+)?(\d+(?:\.\d+)?)\b/gmi,
    /^\s*[-*]\s*(?:Phase\s+)?(\d+(?:\.\d+)?)\b/gmi
  ];
  for(const re of patterns){let m;while((m=re.exec(text))){const id=m[1];if(!seen.has(id)){seen.add(id);ids.push(id);}}}
  return ids.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
}

export function gsdState(repo,info){
  const phaseRoot=info.phaseRoot||".planning/phases";
  const phases=(info.phases||[]).map(p=>({...p,dir:path.join(repo,phaseRoot,p.id)}));
  const planned=phases.find(p=>p.planned&&!p.verified);
  if(planned){
    const ev=phaseEvidence(repo,planned);
    let entryStage="research";
    if(ev.plan) entryStage="execute";
    else if(ev.research) entryStage="plan";
    const status=ev.plan?"complete":ev.research?"partial":"missing";
    return {
      framework:"gsd",status,phase:planned.id,entryStage,evidence:ev,
      requiresValidation:ev.plan,confidence:ev.plan?"high":"medium",
      reason:ev.plan?"PLAN artifacts detected for current phase":ev.research?"research artifact detected but PLAN is incomplete":"phase exists but no research/PLAN evidence"
    };
  }
  const existingIncomplete=phases.find(p=>!p.planned);
  if(existingIncomplete){
    const ev=phaseEvidence(repo,existingIncomplete);
    if(ev.research){
      return {framework:"gsd",status:"partial",phase:existingIncomplete.id,entryStage:"plan",evidence:ev,requiresValidation:false,confidence:"high",reason:"research artifact exists; PLAN is the next unresolved planning stage"};
    }
    return {framework:"gsd",status:"missing",phase:existingIncomplete.id,entryStage:"research",evidence:ev,requiresValidation:false,confidence:"medium",reason:"phase directory exists but research/PLAN evidence is missing"};
  }
  const roadmapIds=roadmapPhaseIds(repo);
  const existingIds=phases.map(p=>p.id);
  const normalizePhase=x=>String(x).toLowerCase().replace(/^0+(?=\d)/,"");
  const nextRoadmap=roadmapIds.find(id=>!existingIds.some(e=>normalizePhase(e)===normalizePhase(id)||String(e).startsWith(`${id}-`)||String(e).startsWith(`${String(id).padStart(2,"0")}-`)));
  if(nextRoadmap){
    return {framework:"gsd",status:"missing",phase:nextRoadmap,entryStage:"discuss",requiresValidation:false,confidence:"medium",reason:"next roadmap phase has no local phase directory yet"};
  }
  if(!roadmapIds.length && fs.existsSync(path.join(repo,".planning","ROADMAP.md"))){
    return {framework:"gsd",status:"ambiguous",phase:null,entryStage:null,requiresValidation:false,confidence:"low",reason:"ROADMAP exists but no phase could be deterministically identified"};
  }
  return {framework:"gsd",status:"complete",phase:null,entryStage:null,requiresValidation:false,confidence:"high",reason:"all discovered roadmap phases are verified"};
}

