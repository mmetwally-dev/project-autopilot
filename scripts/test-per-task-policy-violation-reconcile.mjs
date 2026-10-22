// Backlog #82: both per-task implementer loops must reconcile task checkboxes
// (and clear the pending snapshot) BEFORE dying on a relay policy violation.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const src=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"autopilot.mjs"),"utf8");
let failed=0;
const check=(n,ok)=>{console.log(`${ok?"PASS":"FAIL"} ${n}`);if(!ok)failed++};
for(const [label,key] of [["Standalone","pendingStandaloneCheckboxSnapshot"],["SpecKit","pendingCheckboxSnapshot"]]){
  const call=`reconcileTaskCheckboxesBeforePolicyDie(s,preAttemptTasks,"${label}","${key}");`;
  const i=src.indexOf(`if(taskImpl.policyViolation){\n`);
  const idxs=[...src.matchAll(/if\(taskImpl\.policyViolation\)\{\s*\n\s*(reconcileTaskCheckboxesBeforePolicyDie\([^\n]*\);)\s*\n[^\n]*\n[^\n]*\n\s*die\(formatRelayPolicyViolation/g)].map(m=>m[1]);
  check(`${label}: per-task policy-violation branch reconciles before die`,idxs.includes(call));
}
const h=src.match(/function reconcileTaskCheckboxesBeforePolicyDie[\s\S]*?\n}\n/)?.[0]||"";
check("helper applies pre-attempt states, aborts task_marking_failed, clears snapshot",
  /applyTaskCheckboxStates\(preAttemptTasks\)/.test(h)&&/task_marking_failed/.test(h)&&/delete s\[snapshotKey\]/.test(h));
if(failed)process.exit(1);
console.log("per-task policy-violation reconcile test passed");
