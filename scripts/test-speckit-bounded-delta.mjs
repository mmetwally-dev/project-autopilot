import fs from "node:fs";
import path from "node:path";
import {boundedDeltaBody, buildStandaloneHandoff, truncationWarning, PHASE_DELTA_BUDGET, MISSION_DELTA_BUDGET} from "./standalone-handoff.mjs";

let ok=0,failed=0;
function check(name,cond,detail){
  if(cond){console.log(`PASS ${name}`);ok++;return;}
  console.error(`FAIL ${name}${detail?` :: ${JSON.stringify(detail)}`:""}`);failed++;
}
const src=fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname),"autopilot.mjs"),"utf8");

// Static: no SpecKit prompt inlines a raw scopedDelta(...) between the markers.
check("no raw scopedDelta inlined in prompts",!/\$\{scopedDelta\(/.test(src));
check("speckit sites use shared bounded helper",(src.match(/\$\{speckitBoundedDelta\(/g)||[]).length===4);
check("helper warns on truncation",/function speckitBoundedDelta[\s\S]{0,300}truncationWarning\(meta\)/.test(src));

const small=[{path:"a.js",text:"diff a\n+1"},{path:"b.js",text:"diff b\n+2"}];
const big=(n)=>Array.from({length:n},(_,i)=>({path:`f${i}.js`,text:"x".repeat(30000)}));

// Normal size: body is the plain join, same as the unbounded delta; not truncated.
const n=boundedDeltaBody(small,{kind:"PHASE_VERIFY",baselineKey:"k"});
check("normal delta unchanged",n.body===small.map(c=>c.text).join("\n")&&!n.meta.truncated);
check("empty delta yields empty body",boundedDeltaBody([],{kind:"MISSION_FINAL",baselineKey:"k"}).body==="");

// Oversized: truncated + warning, bounded body, explicit notice.
const t=boundedDeltaBody(big(4),{kind:"PHASE_REVIEW",baselineKey:"phase-key"});
check("oversized phase delta truncated",t.meta.truncated&&t.meta.omittedChunks>=2);
check("phase body within budget",t.body.length<=PHASE_DELTA_BUDGET);
check("notice names omitted files",t.body.includes("TRUNCATED:")&&t.body.includes("f3.js"));
check("warning emitted text",truncationWarning(t.meta).includes("phase-key")&&/omitted/.test(truncationWarning(t.meta)));
const m=boundedDeltaBody(big(5),{kind:"MISSION_FINAL",baselineKey:"mk"});
check("mission uses mission budget",m.meta.truncated&&m.body.length<=MISSION_DELTA_BUDGET&&m.meta.includedChunks===2);

// Parity with Standalone builder: same chunks -> same included/omitted + same delta body.
const base={baselineKey:"phase-key",phaseName:"P",phaseIndex:0,phaseTotal:1,phaseTasks:[{file:"/r/TASKS.md",line:1,text:"t"}],attempt:1,deltaChunks:big(4)};
const h=buildStandaloneHandoff({kind:"PHASE_VERIFY",...base});
check("standalone parity: truncated + same files",h.meta.truncated&&JSON.stringify(h.meta.includedFiles)===JSON.stringify(t.meta.includedFiles)&&h.text.includes(t.body));
check("standalone normal-size parity",buildStandaloneHandoff({kind:"PHASE_VERIFY",...base,deltaChunks:small}).text.includes(n.body));

console.log(`\n${ok} passed, ${failed} failed`);
if(failed) process.exit(1);
