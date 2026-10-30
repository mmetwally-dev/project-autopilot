#!/usr/bin/env node
// Pins the testing-policy note in the GSD plan-phase planner brief.
import {readFileSync} from "node:fs";
import {testingPolicyRuleNote, E2E_SETUP_PHRASE, TESTING_POLICY_RULE_E2E_SET} from "./autopilot.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const src=readFileSync(new URL("./autopilot.mjs",import.meta.url),"utf8");
const a=src.indexOf('Run the GSD plan-phase workflow');
const b=src.indexOf('"Do not commit or push."',a);
check("plan brief found",a>0&&b>a);
check("plan stage injects rule",src.slice(a,b).includes('stage === "plan" ? testingPolicyRuleNote(c) : ""'));
const note=testingPolicyRuleNote({tests:{e2e:"playwright",e2e_setup_pending:true}});
check("pending: plan note has testing rule",note.includes(TESTING_POLICY_RULE_E2E_SET));
check("pending: plan note has no setup phrase",!note.includes(E2E_SETUP_PHRASE));
check("pending: plan note has no @playwright/test",!note.includes("@playwright/test"));
process.exit(fail?1:0);
