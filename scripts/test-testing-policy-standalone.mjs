#!/usr/bin/env node
// Pins the testing-policy note injected into the standalone planner tasksLine.
import {readFileSync} from "node:fs";
import {testingPolicyPromptNote, E2E_SETUP_PHRASE, TESTING_POLICY_RULE_E2E_SET} from "./autopilot.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const pw=testingPolicyPromptNote({tests:{e2e:"playwright",e2e_setup_pending:true}});
const cy=testingPolicyPromptNote({tests:{e2e:"cypress",e2e_setup_pending:true}});
const plain=testingPolicyPromptNote({tests:{e2e:"playwright"}});
const none=testingPolicyPromptNote({});
check("phrase const",E2E_SETUP_PHRASE==="E2E setup");
check("rule present",plain.includes(TESTING_POLICY_RULE_E2E_SET)&&none.includes("Testing policy"));
check("no setup without marker",!plain.includes(E2E_SETUP_PHRASE)&&!none.includes(E2E_SETUP_PHRASE));
check("playwright marker",pw.includes("@playwright/test")&&!/cypress/i.test(pw)&&pw.includes(E2E_SETUP_PHRASE));
check("cypress marker",/cypress/.test(cy)&&!/playwright/i.test(cy)&&cy.includes(E2E_SETUP_PHRASE));
for(const [k,t] of Object.entries({pw,cy,plain,none})) check(k+" no semicolon",!t.includes(";"));
const src=readFileSync(new URL("./autopilot.mjs",import.meta.url),"utf8");
const i=src.indexOf('const tasksLine="Content for TASKS.md:');
check("tasksLine wired",src.slice(i,src.indexOf('const taskSizeLine="',i)).includes("testingPolicyPromptNote(c)"));
process.exit(fail?1:0);
