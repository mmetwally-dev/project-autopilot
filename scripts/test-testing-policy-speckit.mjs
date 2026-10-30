#!/usr/bin/env node
// Pins the testing-policy note in the SpecKit tasks-stage artifact contract.
import {readFileSync} from "node:fs";
import {artifactContractNoteFor, E2E_SETUP_PHRASE, TESTING_POLICY_RULE_E2E_SET} from "./autopilot.mjs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const src=readFileSync(new URL("./autopilot.mjs",import.meta.url),"utf8");
const f=src.indexOf("function artifactContractNoteFor");
const a=src.indexOf('if(step==="tasks") return `',f);
const b=src.indexOf('return "";',a);
const branch=src.slice(a,b);
check("signature takes cfg",src.slice(f,f+90).includes("policy,cfg"));
check("tasks note has rule",branch.includes("${testingPolicyRuleNote(cfg)}"));
check("call site passes config",src.includes("artifactContractNoteFor(step,s.speckitFeatureDir,c.policy,c)"));
const note=artifactContractNoteFor("tasks","001-x",{},{tests:{e2e:"playwright",e2e_setup_pending:true}});
check("pending: tasks note has testing rule",note.includes(TESTING_POLICY_RULE_E2E_SET));
check("pending: tasks note has no setup phrase",!note.includes(E2E_SETUP_PHRASE));
check("pending: tasks note has no @playwright/test",!note.includes("@playwright/test"));
process.exit(fail?1:0);
