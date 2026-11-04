import assert from "node:assert/strict";
import fs from "node:fs";
import {appendFailureHandoff} from "./failure-handoff.mjs";

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const i = src.indexOf("Backlog #116:");
assert.ok(i > 0, "Backlog #116 comment found");
const blk = src.slice(i, i + 2400);

// a. the #116 block's condition contains all roles including plan_reviewer, code_reviewer, verifier.
assert.ok(
  blk.includes('(roleName==="implementer"||roleName==="planner"||roleName==="plan_reviewer"||roleName==="code_reviewer"||roleName==="verifier")'),
  "#116 block condition contains all roles"
);

// b. the condition DOES include plan_reviewer, code_reviewer and verifier (Backlog #7d extension).
const condStart = blk.indexOf("if(");
const condEnd = blk.indexOf("failedRunDidWork");
assert.ok(condStart !== -1 && condEnd !== -1 && condEnd > condStart, "condition bounds found");
const condText = blk.slice(condStart, condEnd);
assert.ok(condText.includes("plan_reviewer"), "condition includes plan_reviewer");
assert.ok(condText.includes("code_reviewer"), "condition includes code_reviewer");
assert.ok(condText.includes("verifier"), "condition includes verifier");

// c. the fallback re-run still uses appendFailureHandoff(task,failureHandoffText,failureHandoffQuotes) (count stays 3 in autopilot.mjs).
const handoffCalls = src.match(/appendFailureHandoff\(task,failureHandoffText,failureHandoffQuotes\)/g) || [];
assert.equal(handoffCalls.length, 3, "appendFailureHandoff(task,failureHandoffText,failureHandoffQuotes) call count is 3");

// d. appendFailureHandoff from scripts/failure-handoff.mjs with a planner-style note ("## Changes made in this session\nspecs/x/tasks.md") returns text that contains the note and "## Hand-off note from the previous session".
const baseTask = "Revise tasks based on review findings";
const plannerNote = "## Changes made in this session\nspecs/x/tasks.md";
const res = appendFailureHandoff(baseTask, plannerNote, "");
assert.ok(res.includes(plannerNote), "output contains planner note");
assert.ok(res.includes("## Hand-off note from the previous session"), "output contains hand-off note heading");

console.log("PASS planner-failure-handoff");

