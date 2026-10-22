import fs from "node:fs";
import path from "node:path";
import {parseInlineRequirements, stripInlineRequirements} from "../scripts/role-requirements.mjs";
import {assertSafeMissionName} from "../scripts/mission-naming.mjs";
import {validateDeclaredPath} from "../scripts/implementation-baseline.mjs";

// Per-mission standalone plan path. `mission` is the resolved mission string
// (e.g. "001-some-feature"), resolved exclusively by the caller — nothing in
// this file resolves a mission name or migrates legacy files (see the
// migration helper in `scripts/mission-naming.mjs`). With no mission there is nothing to report,
// so the path points at a location that reads as "missing".
//
// `assertSafeMissionName` fails closed (throws `UNSAFE_MISSION_NAME`) rather
// than silently sanitizing: a non-empty `mission` reaching this function
// unsanitized (e.g. via a hand-edited `state.json`) is corruption, not a
// formatting nit, and re-sanitizing it here would silently point the caller
// at a different mission folder than the one actually recorded.
export function planPath(repo, mission){
  if(!mission) return path.join(repo,".autopilot","missions","PLAN.md");
  assertSafeMissionName(repo, mission, "standalone mission");
  return path.join(repo,".autopilot","missions",mission,"PLAN.md");
}

export function tasksPath(repo, mission){
  if(!mission) return path.join(repo,".autopilot","missions","TASKS.md");
  assertSafeMissionName(repo, mission, "standalone mission");
  return path.join(repo,".autopilot","missions",mission,"TASKS.md");
}

export function detect(repo, mission){
  return fs.existsSync(planPath(repo, mission)) && fs.existsSync(tasksPath(repo, mission));
}

function parseTasksFile(file){
  if(!fs.existsSync(file)) return [];
  const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
  const out=[];
  let inFence=false;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*(```|~~~)/.test(line)){ inFence=!inFence; continue; }
    if(inFence) continue;
    const m=line.match(/^\s*-\s*\[\s*([xX ]?)\s*\]\s+(.+)$/);
    if(!m) continue;
    const rawText=m[2].trim();
    out.push({file,line:i+1,text:stripInlineRequirements(rawText),requiredCapabilities:parseInlineRequirements(rawText),done:m[1].toLowerCase()==="x"});
  }
  return out;
}

export function tasks(repo, mission){
  return parseTasksFile(tasksPath(repo, mission));
}

export function phases(repo, mission){
  const file=tasksPath(repo, mission);
  if(!fs.existsSync(file)) return [];
  const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
  const result=[];
  let inFence=false;
  let current=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*(```|~~~)/.test(line)){ inFence=!inFence; continue; }
    if(inFence) continue;
    const h=line.match(/^\s*##\s+Phase\s+(\d+)\s*:?\s*(.*)$/i);
    if(h){
      // Use ": Name" in TASKS.md to avoid doubled "— —" (speckit parser does `Phase N — ${h2}`)
      // Here we consume optional leading ":", "-", "—" from captured suffix.
      let suffix=(h[2]||"").trim().replace(/^[:\-—]+\s*/,"").trim();
      current={name:`Phase ${h[1]}${suffix?` — ${suffix}`:""}`,number:Number(h[1]),file,line:i+1,tasks:[],done:true};
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
  return result.filter(p=>p.tasks.length>0);
}

// Standalone equivalent of specKitPhases().flatMap(p=>p.tasks) for checkbox snapshot.
export function snapshotTasks(repo, mission){
  return phases(repo, mission).flatMap(p=>p.tasks).map(t=>({file:t.file,line:t.line,text:t.text,done:t.done}));
}

// Task 3: collect declared gitignored deliverable paths from PLAN.md.
// Union of:
//   - <!-- autopilot-deliverable: <path> --> (inline, inline-comment, multiline-block)
//   - ## Deliverables heading followed by - <path> lines
// Reads both PLAN.md and TASKS.md. TASKS.md <!-- autopilot-deliverable: --> is
// the primary per-task declaration; PLAN.md ## Deliverables heading is fallback.
// Calls validateDeclaredPath (fail-closed, UNSAFE_DELIVERABLE_PATH).
export function declaredDeliverables(repo, mission){
  function parseDeliverables(text){
    const paths=[];
    // <!-- autopilot-deliverable: path --> (inline and multiline block)
    for(const m of text.matchAll(/<!--\s*autopilot-deliverable:\s*([^\n>]+?)\s*-->/ig)){
      paths.push(m[1].trim());
    }
    // ## Deliverables heading: subsequent - <path> lines until next heading
    // Skip fenced code blocks (``` or ~~~).
    const lines=text.split(/\r?\n/);
    let inDeliverables=false;
    let inFence=false;
    for(const line of lines){
      if(/^\s*(```|~~~)/.test(line)){ inFence=!inFence; continue; }
      if(inFence) continue;
      if(/^\s*##\s+Deliverables/i.test(line)){ inDeliverables=true; continue; }
      if(inDeliverables && /^\s*##\s+/.test(line)){ inDeliverables=false; continue; }
      if(inDeliverables){
        const m=line.match(/^\s*-\s+(.+)$/);
        if(m) paths.push(m[1].trim());
      }
    }
    return paths;
  }
  const paths=[];
  // Primary: TASKS.md (per-task inline declarations)
  const taskFile=tasksPath(repo, mission);
  if(fs.existsSync(taskFile)) paths.push(...parseDeliverables(fs.readFileSync(taskFile,"utf8")));
  // Fallback: PLAN.md (heading-level declarations)
  const planFile=planPath(repo, mission);
  if(fs.existsSync(planFile)) paths.push(...parseDeliverables(fs.readFileSync(planFile,"utf8")));
  // Dedupe and validate — fail-closed on any invalid path
  const seen=new Set();
  const out=[];
  for(const raw of paths){
    if(!raw || seen.has(raw)) continue;
    seen.add(raw);
    validateDeclaredPath(repo, mission, raw);
    out.push(raw);
  }
  return out;
}

export function state(repo, mission){
  const planFile=planPath(repo, mission);
  const taskFile=tasksPath(repo, mission);
  if(!fs.existsSync(planFile) || !fs.existsSync(taskFile)) return {framework:"standalone",status:"missing",entryIndex:0,confidence:"high",reason:!fs.existsSync(planFile)?"no standalone PLAN.md exists":"no standalone TASKS.md exists",planFile,tasksFile:taskFile};
  const items=tasks(repo, mission);
  if(!items.length) return {framework:"standalone",status:"ambiguous",entryIndex:0,confidence:"low",reason:"standalone TASKS.md exists but contains no checklist tasks",planFile,tasksFile:taskFile};
  const first=items.findIndex(t=>!t.done);
  return {framework:"standalone",status:first===-1?"complete":"partial",entryIndex:first===-1?items.length:first,confidence:"high",reason:first===-1?"all standalone plan tasks are complete":"standalone checklist has unfinished tasks",planFile,tasksFile:taskFile,tasks:items.length};
}

export function markDone(repo, mission, taskLine){
  // taskLine is 1-indexed public line number (phases/tasks use i+1)
  const file=tasksPath(repo, mission);
  if(!fs.existsSync(file)) return;
  const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
  const idx=taskLine-1;
  if(idx<0||idx>=lines.length) return;
  lines[idx]=lines[idx].replace(/^(\s*-\s*)\[\s*([xX ])?\s*\]/,"$1[x]");
  fs.writeFileSync(file,lines.join("\n"));
}
