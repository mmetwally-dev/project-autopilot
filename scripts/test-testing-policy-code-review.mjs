#!/usr/bin/env node
// Pins CODE_REVIEW_REAL_TESTS_RULE and its code-review injection sites.
import {readFileSync} from "node:fs";
let fail=0;
function check(n,c){if(!c){fail++;console.error("FAIL "+n);}else console.log("ok "+n);}
const src=readFileSync(new URL("./autopilot.mjs",import.meta.url),"utf8");
const m=await import("./autopilot.mjs");
const r=m.CODE_REVIEW_REAL_TESTS_RULE;
check("rule exported",typeof r==="string"&&/always-true/.test(r)&&/empty/.test(r)&&/exercise the behavior/.test(r));
const at=(s)=>{const i=src.indexOf(s);return i<0?"":src.slice(i,i+1200);};
check("review()",at("function review(reviewer").includes("CODE_REVIEW_REAL_TESTS_RULE"));
check("gsd per-plan review",at("Review ONLY GSD plan").includes("CODE_REVIEW_REAL_TESTS_RULE"));
check("gsd phase review",at("Final code review for GSD phase").includes("CODE_REVIEW_REAL_TESTS_RULE"));
check("gsd final review",at("Final repository review across all completed GSD phases").includes("CODE_REVIEW_REAL_TESTS_RULE"));
process.exit(fail?1:0);
