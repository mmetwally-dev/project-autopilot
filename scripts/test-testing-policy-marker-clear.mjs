// Pins clearE2eSetupPending: flips only tests.e2e_setup_pending, leaves the rest untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {clearE2eSetupPending} from "./autopilot.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const mk=(obj)=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),"e2e-clr-"));fs.mkdirSync(path.join(d,".autopilot"));if(obj!==undefined)fs.writeFileSync(path.join(d,".autopilot","config.json"),typeof obj==="string"?obj:JSON.stringify(obj,null,2)+"\n");return d;};
const rd=d=>fs.readFileSync(path.join(d,".autopilot","config.json"),"utf8");
const d1=mk({zeta:1,tests:{e2e:"playwright",e2e_setup_pending:true,x:[1]},alpha:{b:2,a:1}});
const before=rd(d1);
check("returns true",clearE2eSetupPending(d1)===true);
check("marker false",JSON.parse(rd(d1)).tests.e2e_setup_pending===false);
check("only marker differs",rd(d1)===before.replace("\"e2e_setup_pending\": true","\"e2e_setup_pending\": false"));
const d2=mk({tests:{e2e_setup_pending:false}});const b2=rd(d2);
check("no-op when false",clearE2eSetupPending(d2)===false&&rd(d2)===b2);
const d3=mk({a:1});const b3=rd(d3);
check("no-op when absent",clearE2eSetupPending(d3)===false&&rd(d3)===b3);
const d4=mk();
check("no-op when missing file",clearE2eSetupPending(d4)===false&&!fs.existsSync(path.join(d4,".autopilot","config.json")));
const inl='{\n  "role_timeout_minutes": {"a": 1, "b": 2},\n  "task_files": ["x", "y"],\n  "tests": {"e2e": "playwright", "e2e_setup_pending": true, "g": []},\n  "stages": ["a", "b"]\n}';
const d5=mk(inl);
check("inline true",clearE2eSetupPending(d5)===true);
check("inline bytes preserved",rd(d5)===inl.replace('"e2e_setup_pending": true','"e2e_setup_pending": false'));
const d6=mk('{"other":{"tests":{"e2e_setup_pending":true}},"tests":{"e2e_setup_pending":false}}');const b6=rd(d6);
check("nested tests ignored",clearE2eSetupPending(d6)===false&&rd(d6)===b6);
for(const d of [d1,d2,d3,d4,d5,d6])fs.rmSync(d,{recursive:true,force:true});
process.exit(fail?1:0);
