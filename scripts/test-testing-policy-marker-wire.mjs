// Pins the standalone mark_tasks wiring of clearE2eSetupPending (not wired in runImplementation).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {clearE2eSetupPending, testingPolicyPromptNote, tasksIncludeE2eSetup, E2E_SETUP_PHRASE} from "./autopilot.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const src=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"autopilot.mjs"),"utf8");
const a=src.indexOf("async function runStandaloneImplementation(");
const b=src.indexOf("async function runImplementation(");
const standalone=src.slice(a,b>a?b:undefined);
const m=standalone.indexOf('if(stage==="mark_tasks")');
const after=standalone.slice(m,m+3000);
const call=after.indexOf("clearE2eSetupPending(repo)");
check("standalone mark_tasks calls helper",m>0&&call>0);
check("call follows setTaskCheckboxes success",after.indexOf("setTaskCheckboxes(")<after.indexOf("if(!marked.ok)")&&after.indexOf("if(!marked.ok)")<call);
check("call guarded by E2E_SETUP_PHRASE",/if\(tasksIncludeE2eSetup\(phaseTasks\)\)\{\s*try\{clearE2eSetupPending\(repo\)/.test(after));
check("runImplementation does not call helper",!src.slice(b).includes("clearE2eSetupPending("));
// behavior: clearing the marker drops the setup instruction from the next plan prompt
const d=fs.mkdtempSync(path.join(os.tmpdir(),"e2e-wire-"));
fs.mkdirSync(path.join(d,".autopilot"));
const f=path.join(d,".autopilot","config.json");
fs.writeFileSync(f,JSON.stringify({tests:{e2e:"playwright",e2e_setup_pending:true}},null,2)+"\n");
const cfg=()=>JSON.parse(fs.readFileSync(f,"utf8"));
check("pending: setup instruction present",testingPolicyPromptNote(cfg()).includes(E2E_SETUP_PHRASE));
// other tasks marked: guard is false, so marker stays true and config is byte-identical
const before=fs.readFileSync(f,"utf8");
const others=[{text:"Add login form"},{text:"Wire API"}];
if(tasksIncludeE2eSetup(others))clearE2eSetupPending(d);
check("other tasks: guard false",!tasksIncludeE2eSetup(others));
check("other tasks: marker still true",cfg().tests.e2e_setup_pending===true);
check("other tasks: config byte-identical",fs.readFileSync(f,"utf8")===before);
check("setup task: guard true",tasksIncludeE2eSetup([{text:"E2E setup: install playwright"}]));
clearE2eSetupPending(d);
check("cleared: marker false",cfg().tests.e2e_setup_pending===false);
check("cleared: no setup instruction",!testingPolicyPromptNote(cfg()).includes(E2E_SETUP_PHRASE));
fs.rmSync(d,{recursive:true,force:true});
process.exit(fail?1:0);
