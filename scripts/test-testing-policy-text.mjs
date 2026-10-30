#!/usr/bin/env node
// Pins the testing-policy planner rule text (no semicolons, names the levels).
import {TESTING_POLICY_RULE, TESTING_POLICY_RULE_E2E_SET, TESTING_POLICY_RULE_E2E_NONE} from "./autopilot.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
for(const [k,t] of Object.entries({base:TESTING_POLICY_RULE,set:TESTING_POLICY_RULE_E2E_SET,none:TESTING_POLICY_RULE_E2E_NONE})){
  check(k+" is string",typeof t==="string"&&t.length>40);
  check(k+" no semicolon",typeof t==="string"&&!t.includes(";"));
  check(k+" levels",/unit/.test(t)&&/integration/.test(t)&&/component/.test(t));
  check(k+" one E2E per feature",/one E2E test per user-facing feature/.test(t));
  check(k+" verify",/verify/.test(t));
}
process.exit(fail?1:0);
