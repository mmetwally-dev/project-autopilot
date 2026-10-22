import assert from "node:assert/strict";
import {findAnchoredTests, formatAnchoredTestsSection, removedSourceLines, isTestPath} from "./anchored-tests.mjs";

const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const diff=(file,removed,added)=>`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n${removed.map(l=>"-"+l).join("\n")}\n${added.map(l=>"+"+l).join("\n")}\n`;

const callLine='const r=await relayAsync("planner",prompt,c,s,{resume:false});';
const t1={path:"scripts/test-a.mjs",text:`assert.match(src,/${esc(callLine)}/);`};
const t2={path:"scripts/test-b.mjs",text:"nothing relevant here"};

// relayAsync call edit -> regex-escaped anchor found
let r=findAnchoredTests({diffText:diff("scripts/autopilot.mjs",[`  ${callLine}`],[`  const r=await relayAsync("planner",prompt,c,s,{resume:false,planRevision:revision});`]),testFiles:[t1,t2]});
assert.deepEqual(r.map(x=>x.test),["scripts/test-a.mjs"]);

// import-list change found (plain substring)
const imp='import {alpha, beta, gamma} from "./mod.mjs";';
r=findAnchoredTests({diffText:diff("scripts/x.mjs",[imp],['import {alpha, beta, gamma, delta} from "./mod.mjs";']),testFiles:[{path:"scripts/test-c.mjs",text:`assert.ok(src.includes('${imp}'))`},t2]});
assert.deepEqual(r.map(x=>x.test),["scripts/test-c.mjs"]);

// short / brace-only / comment lines ignored
r=findAnchoredTests({diffText:diff("scripts/x.mjs",["}","  });","  return x;","// a long comment line that is surely longer than 25 chars"],[]),testFiles:[{path:"scripts/test-d.mjs",text:"} }); return x; // a long comment line that is surely longer than 25 chars"}]});
assert.deepEqual(r,[]);

// test files in the diff are not sources
const tdiff=diff("scripts/test-z.mjs",[callLine],[]);
assert.deepEqual(removedSourceLines(tdiff),[]);
assert.deepEqual(findAnchoredTests({diffText:tdiff,testFiles:[t1]}),[]);
assert.equal(isTestPath("scripts/test-x.mjs"),true);
assert.equal(isTestPath("scripts/autopilot.mjs"),false);

// empty diff / no tests
assert.deepEqual(findAnchoredTests({diffText:"",testFiles:[t1]}),[]);
assert.deepEqual(findAnchoredTests({}),[]);

// cap respected
const many=Array.from({length:30},(_,i)=>({path:`scripts/test-m${String(i).padStart(2,"0")}.mjs`,text:callLine}));
const d=diff("scripts/autopilot.mjs",[callLine],[]);
assert.equal(findAnchoredTests({diffText:d,testFiles:many}).length,15);
assert.equal(findAnchoredTests({diffText:d,testFiles:many,max:3}).length,3);

// brief section only when non-empty
assert.equal(formatAnchoredTestsSection([]),"");
assert.equal(formatAnchoredTestsSection(undefined),"");
const sec=formatAnchoredTestsSection([{test:"scripts/test-a.mjs",lines:[]},{test:"scripts/test-b.mjs",lines:[]}]);
assert.ok(sec.startsWith("Tests that anchor on text you changed"));
assert.ok(sec.includes("node scripts/test-a.mjs; node scripts/test-b.mjs"));

console.log("test-anchored-tests: ok");
