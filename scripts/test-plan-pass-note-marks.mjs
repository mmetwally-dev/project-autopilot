#!/usr/bin/env node
// Backlog #12: PASS-NOTE mark parsing (bullets/bold/trailing text) and
// phase-review marks recorded from PASS and FAIL verdicts, once each.
import fs from "node:fs";
import { recordPlanPassNotes, parsePlanPassNoteMarks, applyPlanPassNoteMarks, planPassNoteEntries } from "./plan-review-rounds.mjs";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail ?? ""}`}`);
  if (!ok) failed++;
};
const one = (line) => parsePlanPassNoteMarks(line);
const is = (line, n, status) => {
  const m = one(line);
  return m.length === 1 && m[0].n === n && m[0].status === status;
};

check("real bullet + em dash applied", is("- PASS-NOTE 1: applied — the tests mock getAuthenticatedUser", 1, "done"));
check("real bullet applied with parens reason", is("- PASS-NOTE 1: applied (the forged-claims tests in the route tests mock the auth layer)", 1, "done"));
check("real bullet applied with plan text", is("- PASS-NOTE 3: applied — plan Phase 5 item 4 now covers legacy", 3, "done"));
const skipped = one("- PASS-NOTE 7: skipped — I didn't check the tasks.md coverage");
check("real bullet skipped keeps reason", skipped.length === 1 && skipped[0].n === 7 && skipped[0].status === "skipped" && skipped[0].reason === "I didn't check the tasks.md coverage", JSON.stringify(skipped));
check("plain applied", is("PASS-NOTE 3: applied", 3, "done"));
check("star bullet", is("* PASS-NOTE 2: applied", 2, "done"));
check("unicode bullet", is("• PASS-NOTE 2: applied", 2, "done"));
check("numbered bullet", is("1. PASS-NOTE 4: applied", 4, "done"));
check("bold", is("**PASS-NOTE 5: applied**", 5, "done"));
check("bullet + bold + trailing", is("- **PASS-NOTE 5: applied** — done", 5, "done"));
check("backticks", is("`PASS-NOTE 6: applied`", 6, "done"));
check("applied: why", is("PASS-NOTE 6: applied: covered by test", 6, "done"));
check("applied - why", is("PASS-NOTE 6: applied - covered by test", 6, "done"));
check("sentence mention is not a mark", one("I looked at PASS-NOTE 3: applied and agree").length === 0);
check("sentence mention after bullet text is not a mark", one("- see PASS-NOTE 3: applied above").length === 0);
check("skipped without reason is not a mark", one("- PASS-NOTE 7: skipped").length === 0);
check("skipped dash with no text is not a mark", one("- PASS-NOTE 7: skipped —").length === 0);

// FAIL-shaped phase review records done, never skipped (allowSkip:false)
const state = {};
recordPlanPassNotes(state, "standalone-plan", ["a", "b", "c"]);
const failReview = {
  status: "completed",
  review: { decision: "FAIL", notes: ["- PASS-NOTE 1: applied — covered", "PASS-NOTE 2: skipped — nope"] },
  finalMessage: "PASS-NOTE 3: applied",
};
const count = applyPlanPassNoteMarks(state, failReview, { phase: 10, allowSkip: false });
const entries = planPassNoteEntries(state);
check("FAIL phase review records applied marks only", count === 2 && entries[0].status === "done" && entries[0].phase === 10 && entries[1].status === "open" && entries[2].status === "done", JSON.stringify(entries));

// Source: both phase review loops apply marks once, in the shared verdict block
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
for (const [name, scope] of [["standalone", "task:standalone:phase-"], ["speckit", "task:speckit:phase-"]]) {
  const start = src.indexOf("clearContinuationRound(s,`" + scope);
  const verdictStart = src.lastIndexOf('if(rv.status==="completed"&&(rv.review?.decision==="PASS"||rv.review?.decision==="FAIL")){', start);
  const verdictEnd = src.indexOf("\n        }", start);
  const block = src.slice(verdictStart, verdictEnd);
  const call = "applyPlanPassNoteMarks(s, rv, {phase:s.phaseIndex+1, allowSkip:false})";
  check(`${name} verdict block (PASS or FAIL) applies marks`, verdictStart >= 0 && block.includes(call));
}
const callText = "applyPlanPassNoteMarks(s, rv, {phase:s.phaseIndex+1, allowSkip:false})";
check("phase review marks applied exactly once per loop (2 sites total)", src.split(callText).length - 1 === 2);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll plan-pass-note-marks checks passed.");
