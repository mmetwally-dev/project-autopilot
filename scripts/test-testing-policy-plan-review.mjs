#!/usr/bin/env node
// Pins PLAN_REVIEW_TESTING_RULE and its four plan-review injection sites.
import {readFileSync} from "node:fs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const src=readFileSync(new URL("./autopilot.mjs",import.meta.url),"utf8");
const m=await import("./autopilot.mjs");
const r=m.PLAN_REVIEW_TESTING_RULE;
check("rule exported",typeof r==="string"&&/BLOCKING/.test(r)&&/playwright or cypress/.test(r)&&/none or unset/.test(r));
const at=(s)=>{const i=src.indexOf(s);return i<0?"":src.slice(i,i+3000);};
check("standalone reviewPrompt",at("const reviewPrompt=[").includes("PLAN_REVIEW_TESTING_RULE,"));
check("existing-plan validation",at("Validate the existing ${subject}").includes("PLAN_REVIEW_TESTING_RULE,"));
check("gsd review prompt",at("function gsdPlanningReviewPrompt").includes("PLAN_REVIEW_TESTING_RULE,"));
check("speckit tasks review",at("const tasksGateNote").includes("${PLAN_REVIEW_TESTING_RULE}"));
process.exit(fail?1:0);
