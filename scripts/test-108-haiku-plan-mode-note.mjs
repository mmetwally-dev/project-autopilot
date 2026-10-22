#!/usr/bin/env node
import assert from "node:assert/strict";
import {isHaikuOnReadOnlyClaudeRole as f, planModeModelWarnings as w} from "./plan-mode-model-note.mjs";
for (const m of ["haiku","Haiku","claude-haiku-4-5","claude-haiku-4-5-20251001"])
  for (const r of ["plan_reviewer","code_reviewer","verifier"]) assert.equal(f(r,"claude",m),true,`${r} ${m}`);
assert.equal(f("implementer","claude","haiku"),false);
assert.equal(f("planner","claude","haiku"),false);
assert.equal(f("verifier","opencode","haiku"),false);
assert.equal(f("verifier","claude","sonnet"),false);
assert.equal(f("verifier","claude","opus"),false);
assert.equal(f("verifier","claude",""),false);
assert.equal(f("verifier","claude",undefined),false);
const ws=w({verifier:{adapter:"claude",model:"haiku",fallbacks:[{adapter:"claude",model:"claude-haiku-4-5"}]},
  implementer:{adapter:"claude",model:"haiku"},code_reviewer:{adapter:"claude",model:"opus"}});
assert.equal(ws.length,2);
assert.ok(ws.every(x=>x.includes("verifier")&&x.includes("Sonnet")));
assert.deepEqual(w(undefined),[]);
console.log("test-108 ok");
