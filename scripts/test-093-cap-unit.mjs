#!/usr/bin/env node
// Mission 093 Part 1 task 1.4: unit test for capUnitLabel (scripts/per-task-budget.mjs).
import { capUnitLabel } from "./per-task-budget.mjs";

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

assert(capUnitLabel("turns") === "turns", `turns cap should label "turns", got: ${capUnitLabel("turns")}`);
assert(capUnitLabel("tokens") === "raw context tokens", `tokens cap should label "raw context tokens", got: ${capUnitLabel("tokens")}`);
assert(capUnitLabel("bogus") === "raw context tokens", `unknown cap should label "raw context tokens", got: ${capUnitLabel("bogus")}`);
assert(capUnitLabel(undefined) === "raw context tokens", "undefined cap should label raw context tokens");
assert(capUnitLabel(null) === "raw context tokens", "null cap should label raw context tokens");

console.log("test-093-cap-unit: ok (turns/tokens/unknown branches)");
