#!/usr/bin/env node
// Pins the no-E2E report note: present only when tests.e2e is none/unset and a UI is detected.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {noE2eReportNote,appendNoE2eNoteToReport,NO_E2E_REPORT_NOTE,renderWatchReport} from "./run-history.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const mk=(deps)=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),"e2e-note-"));fs.mkdirSync(path.join(d,".autopilot"),{recursive:true});fs.writeFileSync(path.join(d,"package.json"),JSON.stringify({dependencies:deps}));return d;};
const ui=mk({react:"18.0.0"}), api=mk({express:"4.0.0"});
check("note text",NO_E2E_REPORT_NOTE==="no E2E — UI checked by component tests only");
check("ui + unset",noE2eReportNote(ui,{})===NO_E2E_REPORT_NOTE);
check("ui + none",noE2eReportNote(ui,{tests:{e2e:"none"}})===NO_E2E_REPORT_NOTE);
check("ui + playwright",noE2eReportNote(ui,{tests:{e2e:"playwright"}})===null);
check("no ui + none",noE2eReportNote(api,{tests:{e2e:"none"}})===null);
fs.writeFileSync(path.join(ui,".autopilot","config.json"),JSON.stringify({tests:{e2e:"cypress"}}));
check("reads raw config",noE2eReportNote(ui)===null);
let out="";try{out=renderWatchReport(mk({react:"18.0.0"}),"m1");}catch(e){console.error(e.message);}
check("watch report has note",out.includes(NO_E2E_REPORT_NOTE));
let out2="";try{out2=renderWatchReport(api,"m1");}catch{}
check("watch report no note without UI",out2!==""&&!out2.includes(NO_E2E_REPORT_NOTE));
const rep=(d)=>path.join(d,"REPORT.md");
const ui2=mk({react:"18.0.0"}),ui3=mk({react:"18.0.0"});
fs.writeFileSync(rep(ui2),"# Report\n");fs.writeFileSync(rep(ui3),"# Report\n");fs.writeFileSync(rep(api),"# Report\n");
check("append: ui+unset writes",appendNoE2eNoteToReport(ui2,rep(ui2))===true);
appendNoE2eNoteToReport(ui2,rep(ui2));
check("append: exactly once",fs.readFileSync(rep(ui2),"utf8").split(NO_E2E_REPORT_NOTE).length===2);
fs.writeFileSync(path.join(ui2,".autopilot","config.json"),JSON.stringify({tests:{e2e:"none"}}));
check("append: ui+none already present",appendNoE2eNoteToReport(ui2,rep(ui2))===false);
fs.writeFileSync(path.join(ui3,".autopilot","config.json"),JSON.stringify({tests:{e2e:"playwright"}}));
check("append: playwright no note",appendNoE2eNoteToReport(ui3,rep(ui3))===false&&!fs.readFileSync(rep(ui3),"utf8").includes(NO_E2E_REPORT_NOTE));
check("append: non-UI no note",appendNoE2eNoteToReport(api,rep(api))===false&&!fs.readFileSync(rep(api),"utf8").includes(NO_E2E_REPORT_NOTE));
for(const d of [ui,api,ui2,ui3])fs.rmSync(d,{recursive:true,force:true});
process.exit(fail?1:0);
