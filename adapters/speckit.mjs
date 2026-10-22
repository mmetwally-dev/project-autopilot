import fs from "node:fs";
import path from "node:path";
import {parseInlineRequirements, stripInlineRequirements} from "../scripts/role-requirements.mjs";

export function detect(repo){return fs.existsSync(path.join(repo,".specify","workflows","speckit","workflow.yml"));}

function parseWorkflow(file){
  const lines=fs.readFileSync(file,"utf8").split(/\r?\n/), steps=[]; let cur=null;
  for(const line of lines){
    const m=line.match(/^\s*-\s+id:\s*(.+)$/);
    if(m){ if(cur) steps.push(cur); cur={id:m[1].trim().replace(/^["']|["']$/g,"")}; continue; }
    if(!cur) continue;
    for(const [key,rx] of [["type",/^\s+type:\s*(.+)$/],["command",/^\s+command:\s*(.+)$/],["message",/^\s+message:\s*(.+)$/]]){
      const mm=line.match(rx); if(mm) cur[key]=mm[1].trim().replace(/^["']|["']$/g,"");
    }
  }
  if(cur) steps.push(cur);
  return steps;
}

export function inspect(repo){
  const workflow=path.join(repo,".specify","workflows","speckit","workflow.yml");
  if(!detect(repo)) return {id:"speckit",detected:false};
  const steps=parseWorkflow(workflow);
  return {id:"speckit",detected:true,workflowFile:workflow,steps,
    commands:steps.filter(x=>x.command),gates:steps.filter(x=>x.type==="gate")};
}

export function taskFiles(repo,candidates){
  const out=[];
  for(const pattern of candidates||[]){
    if(!pattern.includes("*")){const f=path.join(repo,pattern);if(fs.existsSync(f))out.push(f);continue;}
    const base=path.join(repo,pattern.split("*")[0]); if(!fs.existsSync(base)) continue;
    const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
      const f=path.join(d,e.name);
      if(e.isDirectory()) walk(f);
      else if(f.endsWith(".md")&&f.toLowerCase().includes("tasks")) out.push(f);
    }}; walk(base);
  }
  return [...new Set(out)];
}

export function tasks(repo,candidates){
  const result=[];
  for(const file of taskFiles(repo,candidates)){
    const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
    let inFence=false;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(/^\s*(```|~~~)/.test(line)){ inFence=!inFence; continue; }
      if(inFence) continue;
      const m=line.match(/^\s*-\s*\[\s*([xX ]?)\s*\]\s+(.+)$/);
      if(m){const rawText=m[2].trim();result.push({file,line:i+1,text:stripInlineRequirements(rawText),requiredCapabilities:parseInlineRequirements(rawText),done:m[1].toLowerCase()==="x"});}
    }
  }
  return result;
}

export function phases(repo,candidates){
  const result=[];
  for(const file of taskFiles(repo,candidates)){
    const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
    let inFence=false;
    let current=null;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(/^\s*(```|~~~)/.test(line)){ inFence=!inFence; continue; }
      if(inFence) continue;
      const h=line.match(/^\s*##\s+Phase\s+(\d+)\s*:?\s*(.*)$/i);
      if(h){
        current={name:`Phase ${h[1]}${h[2]?` — ${h[2].trim()}`:""}`,number:Number(h[1]),file,line:i+1,tasks:[],done:true};
        result.push(current);
        continue;
      }
      if(!current) continue;
      const m=line.match(/^\s*-\s*\[\s*([xX ]?)\s*\]\s+(.+)$/);
      if(m){
        const rawText=m[2].trim();
        const task={file,line:i+1,text:stripInlineRequirements(rawText),requiredCapabilities:parseInlineRequirements(rawText),done:m[1].toLowerCase()==="x"};
        current.tasks.push(task);
        if(!task.done) current.done=false;
      }
    }
  }
  return result.filter(p=>p.tasks.length>0);
}
