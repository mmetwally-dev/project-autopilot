#!/usr/bin/env node
// Mission 051 Phase 1 task 1.4 — final-review fix-round wiring test.
//
// Covers every final-review FAIL site in scripts/autopilot.mjs (early-final
// no-pending path, post-loop standalone mission-final, SpecKit mission-final):
// each routes through runFinalReviewFixRounds with a finding record, a
// fixPassBriefExcerpts brief, an implementer fix pass, a re-review and a
// linked evidence check per round, escalating only when the budget is
// exhausted. The two standalone sites share the
// runStandaloneFinalReviewFixRounds driver (task 1.3); the SpecKit site calls
// the helper inline (task 1.4). autopilot.mjs runs main() on import, so the
// wiring half is static-covered here (same pattern as
// test-cap-breach-wiring); the behavioural half drives the real helper with
// site-shaped deps (fix pass + re-review + evidence check) and asserts the
// fix pass runs before each re-review, so a FAIL can never loop on unchanged
// code while still burning budget.
import fs from "node:fs";
import {
  FINAL_REVIEW_FIX_ROUNDS_STATE_KEY,
  runFinalReviewFixRounds,
} from "./final-review-fix-rounds.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(String(evidence).slice(0, 500))}` : ""}`);
  failed += 1;
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Static wiring: helper imported ──
check("wiring: helper imported",
  /import \{[^}]*runFinalReviewFixRounds[^}]*\} from "\.\/final-review-fix-rounds\.mjs"/.test(src));

// ── Static wiring: shared driver exists and wires a real fix round ──
const driverAt = src.indexOf("async function runStandaloneFinalReviewFixRounds");
check("wiring: shared standalone driver defined", driverAt !== -1);
const driverEnd = driverAt !== -1 ? src.indexOf("async function runStandaloneImplementation", driverAt) : -1;
const driverSlice = driverAt !== -1 ? src.slice(driverAt, driverEnd !== -1 ? driverEnd : driverAt + 4000) : "";
check("wiring: driver loops through runFinalReviewFixRounds",
  driverSlice.includes("runFinalReviewFixRounds({"), driverSlice.slice(0, 200));
check("wiring: driver wires an implementer fix pass (runFixPass relays findings)",
  driverSlice.includes("runFixPass") && driverSlice.includes('relay("implementer"'),
  driverSlice.slice(0, 200));
check("wiring: driver briefs the fix pass from findings (fixPassBriefExcerpts)",
  driverSlice.includes("runFixPass:async({brief,findings")
    && fs.readFileSync(new URL("./final-review-fix-rounds.mjs", import.meta.url), "utf8")
      .includes("fixPassBriefExcerpts"),
  driverSlice.slice(0, 200));
check("wiring: driver passes the brief reader (readFile)",
  driverSlice.includes("readFile:fixPassBriefReadFile"), driverSlice.slice(0, 200));
check("wiring: driver records the finding chain (recordArgs)",
  driverSlice.includes("recordArgs") && driverSlice.includes("standalone-final:"),
  driverSlice.slice(0, 200));
check("wiring: driver rebuilds the handoff fresh every round (no stale delta)",
  driverSlice.includes("const handoff=buildStandaloneHandoff")
    && driverSlice.includes("deltaChunks:scopedDeltaChunks(repo,missionBaselineKey")
    && !driverSlice.includes("${finalHandoff.text}"),
  driverSlice.slice(0, 200));
check("wiring: driver re-reviews via the code_reviewer",
  driverSlice.includes("runFinalReview:async(") && driverSlice.includes('review("code_reviewer"'));
check("wiring: driver re-checks linked evidence per round",
  driverSlice.includes("checkEvidenceRefusal") && driverSlice.includes("shouldRefusePassForEvidence"));

// ── Static wiring: both standalone sites route through the driver ──
const earlyMarker = "Standalone early final review INCOMPLETE treated as FAIL";
const finalMarker = "Standalone final review INCOMPLETE treated as FAIL";
const speckitMarker = "SpecKit final review INCOMPLETE treated as FAIL";
const earlyAt = src.indexOf(earlyMarker);
const finalAt = src.indexOf(finalMarker);
const speckitAt = src.indexOf(speckitMarker);
check("wiring: early-final marker present", earlyAt !== -1);
check("wiring: mission-final marker present", finalAt !== -1 && finalAt !== earlyAt);
check("wiring: speckit mission-final marker present", speckitAt !== -1 && speckitAt !== finalAt);
const earlySlice = earlyAt !== -1 ? src.slice(earlyAt, earlyAt + 2500) : "";
// Mission-final slice runs to the end of runStandaloneImplementation; the
// SpecKit site (task 1.4) lives beyond it, so cap the slice before the next
// framework marker.
const speckitFnAt = src.indexOf("runImplementation", finalAt);
const finalSlice = finalAt !== -1 ? src.slice(finalAt, speckitFnAt !== -1 ? speckitFnAt : finalAt + 2500) : "";
for (const [label, slice, site] of [["early-final", earlySlice, "early-final"], ["mission-final", finalSlice, "mission-final"]]) {
  check(`wiring: ${label} site routes through the shared driver`,
    slice.includes("runStandaloneFinalReviewFixRounds({") && slice.includes(`site:"${site}"`),
    slice.slice(0, 200));
  check(`wiring: ${label} site keeps no weak inline loop`,
    !slice.includes("runFinalReviewFixRounds({"), slice.slice(0, 200));
  check(`wiring: ${label} site escalates with step final_review`,
    slice.includes('s.step=') && slice.includes('||"final_review"'), slice.slice(0, 200));
  check(`wiring: ${label} site keeps the escalation message`,
    slice.includes('"Final review failed."'));
  check(`wiring: ${label} pass-through falls to mission completion (no die)`,
    slice.includes('outcome==="passed"'));
}
// SpecKit mission-final slice: inline helper call (no driver — the site owns
// its own speckit review prompt), but it must still wire a real fix round.
const speckitNextFn = speckitAt !== -1 ? src.indexOf("\nfunction ", speckitAt + speckitMarker.length) : -1;
const speckitSlice = speckitAt !== -1 ? src.slice(speckitAt, speckitNextFn !== -1 ? speckitNextFn : speckitAt + 3500) : "";
{
  const label = "speckit mission-final";
  check(`wiring: ${label} site loops through runFinalReviewFixRounds`,
    speckitSlice.includes("runFinalReviewFixRounds({"), speckitSlice.slice(0, 200));
  check(`wiring: ${label} site wires an implementer fix pass (runFixPass relays findings)`,
    /runFixPass:async\(/.test(speckitSlice) && speckitSlice.includes('relay("implementer"'),
    speckitSlice.slice(0, 200));
  check(`wiring: ${label} fix pass relays the findings AND the brief`,
    speckitSlice.includes("runFixPass:async({brief,findings")
      && speckitSlice.includes("feedbackText(findings)") && speckitSlice.includes("${brief"),
    speckitSlice.slice(0, 200));
  check(`wiring: ${label} site escalates a fix-pass policy violation`,
    /s\.step="relay_policy_violation"/.test(speckitSlice), speckitSlice.slice(0, 200));
  check(`wiring: ${label} site passes the brief reader (readFile)`,
    speckitSlice.includes("readFile:fixPassBriefReadFile"), speckitSlice.slice(0, 200));
  check(`wiring: ${label} site records the finding chain (recordArgs)`,
    speckitSlice.includes("recordArgs") && speckitSlice.includes("speckit-final:mission-final"),
    speckitSlice.slice(0, 200));
  check(`wiring: ${label} site re-reviews via the code_reviewer`,
    /runFinalReview:async\(/.test(speckitSlice)
      && /runFinalReview:async\([\s\S]{0,600}?review\("code_reviewer"/.test(speckitSlice),
    speckitSlice.slice(0, 200));
  check(`wiring: ${label} site runs the gate dep (mission-final runs none → null)`,
    /runGate:async\(\)=>null/.test(speckitSlice), speckitSlice.slice(0, 200));
  check(`wiring: ${label} site re-checks linked evidence per round`,
    speckitSlice.includes("checkEvidenceRefusal") && speckitSlice.includes("shouldRefusePassForEvidence"));
  check(`wiring: ${label} site escalates with step final_review`,
    speckitSlice.includes('s.step=') && speckitSlice.includes('"final_review"'), speckitSlice.slice(0, 200));
  check(`wiring: ${label} site keeps the escalation message`,
    speckitSlice.includes('"Final review failed."'));
  check(`wiring: ${label} pass-through falls to mission completion (no die)`,
    speckitSlice.includes('outcome==="passed"'));
}

// ── Static wiring: gate-green evidence (mission 062 task 1.3) ──
// gates() replaces the stored green list every run (latest wins) as a sorted
// array next to recordGateDurations, tied to the current mission and deleted
// on mission completion; both helper call sites rehydrate it to a Set via
// the new gateGreenFiles named argument while keeping runGate null (no fresh
// mission-final gate run).
check("wiring: gate-green parser imported",
  /import \{[^}]*parseGateGreenFiles[^}]*\} from "\.\/final-review-fix-rounds\.mjs"/.test(src));
check("wiring: gates() stores the green list next to durations (latest wins, sorted)",
  src.includes("recordGateGreenFiles(s,results,mission)")
    && src.includes("s.gateGreenFiles = [...parseGateGreenFiles(text)].sort()"),
  src.slice(src.indexOf("function recordGateGreenFiles"), src.indexOf("function recordGateGreenFiles") + 200));
check("wiring: gate-green evidence tied to the current mission",
  src.includes("s.gateGreenMission = mission") && src.includes("s.gateGreenMission !== mission"),
  "gateGreenMission");
check("wiring: terminal state deletes gate-green evidence",
  /delete s\.gateGreenFiles;[\s\S]{0,80}?delete s\.gateGreenMission;/.test(src));
check("wiring: driver rehydrates green to a Set with no fresh gate run",
  driverSlice.includes("gateGreenFiles:readGateGreenFilesSet(s,missionDirFor(repo,s))")
    && !driverSlice.includes("gates(c,s)"),
  driverSlice.slice(0, 200));
check("wiring: driver keeps the null gate dep",
  /runGate:async\(\)=>null/.test(driverSlice), driverSlice.slice(0, 200));
check("wiring: speckit site passes the green Set and keeps the null gate dep",
  speckitSlice.includes("gateGreenFiles:readGateGreenFilesSet(s,missionDirFor(repo,s))")
    && /runGate:async\(\)=>null/.test(speckitSlice),
  speckitSlice.slice(0, 200));

// ── Behavioural: driver-shaped deps (fix pass + re-review + evidence check) ──
const FAIL = {status: "completed", review: {decision: "FAIL", findings: ["finding one"]}};
const PASS = {status: "completed", review: {decision: "PASS", findings: []}};
// Driver-shaped deps: finding record + fix brief + implementer fix pass,
// then the re-review, then the evidence check — mirroring
// runStandaloneFinalReviewFixRounds. The events log proves the fix pass runs
// before each re-review (a FAIL can never loop on unchanged code).
const driverDeps = (events, runFinalReview) => ({
  recordArgs: {key: "standalone-final:mission-final"},
  readFile: () => null,
  runFixPass: async ({brief, findings, round}) => { events.push(`fix:${round}`); return {brief, findings}; },
  runGate: async () => null,
  runFinalReview: async (args) => { events.push(`review:${args.round}`); return runFinalReview(args); },
  checkEvidenceRefusal: () => null,
});

// FAIL-once-then-PASS completes without escalation.
{
  const state = {};
  const events = [];
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: driverDeps(events, async () => { reviews += 1; return reviews === 1 ? FAIL : PASS; }),
  });
  check("behavior: FAIL-once-then-PASS completes without escalation",
    result.outcome === "passed" && result.review?.review?.decision === "PASS",
    JSON.stringify({outcome: result.outcome}));
  check("behavior: fix pass runs before each re-review",
    JSON.stringify(events) === JSON.stringify(["fix:1", "review:1", "fix:2", "review:2"]),
    JSON.stringify(events));
  check("behavior: counter persisted across the site loop rounds",
    state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === 2, JSON.stringify(state));
}

// Over-budget FAILs escalate with step final_review.
{
  const state = {};
  const events = [];
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: driverDeps(events, async () => { reviews += 1; return FAIL; }),
  });
  check("behavior: over-budget FAILs escalate",
    result.outcome === "escalate" && reviews === 2, JSON.stringify({outcome: result.outcome, reviews}));
  check("behavior: every round ran a fix pass before its re-review",
    JSON.stringify(events) === JSON.stringify(["fix:1", "review:1", "fix:2", "review:2"]),
    JSON.stringify(events));
  check("behavior: escalation uses step final_review",
    result.step === "final_review", JSON.stringify({step: result.step}));
  check("behavior: escalation keeps the message",
    result.message === "Final review failed.", JSON.stringify({message: result.message}));
}

// Bypass paths consume no budget (caller keeps its immediate escalation).
{
  const state = {};
  const events = [];
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialEvidenceRefusal: {refuse: true},
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: driverDeps(events, async () => { reviews += 1; return PASS; }),
  });
  check("behavior: evidence refusal bypasses without consuming a round",
    result.outcome === "bypass" && reviews === 0 && events.length === 0
      && state[FINAL_REVIEW_FIX_ROUNDS_STATE_KEY] === undefined,
    JSON.stringify({outcome: result.outcome, reviews}));
}

// ── Behavioural: SpecKit mission-final site shape (task 1.4 scope) ──
// The SpeKit site calls the helper inline (no driver), so its deps are shaped
// like the site itself: finding record + brief reader + implementer fix pass,
// a null gate (mission-final runs no phase gates), the speckit re-review and
// the linked-evidence check. The events log proves the fix pass runs before
// each re-review.
const siteDeps = (events, runFinalReview) => ({
  recordArgs: {key: "speckit-final:mission-final"},
  readFile: () => null,
  runFixPass: async ({brief, findings, round}) => { events.push(`fix:${round}`); return {brief, findings}; },
  runGate: async () => null,
  runFinalReview: async (args) => { events.push(`review:${args.round}`); return runFinalReview(args); },
  checkEvidenceRefusal: () => null,
});
{
  const state = {};
  const events = [];
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: siteDeps(events, async () => { reviews += 1; return reviews === 1 ? FAIL : PASS; }),
  });
  check("behavior: speckit FAIL-once-then-PASS completes without escalation",
    result.outcome === "passed" && result.review?.review?.decision === "PASS",
    JSON.stringify({outcome: result.outcome}));
  check("behavior: speckit site runs a fix pass before each re-review",
    JSON.stringify(events) === JSON.stringify(["fix:1", "review:1", "fix:2", "review:2"]),
    JSON.stringify(events));
}
{
  const state = {};
  const events = [];
  let reviews = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: FAIL,
    initialEvidenceRefusal: null,
    initialFindings: ["finding one"],
    saveState: () => {},
    deps: siteDeps(events, async () => { reviews += 1; return FAIL; }),
  });
  check("behavior: speckit over-budget FAILs escalate with step final_review",
    result.outcome === "escalate" && result.step === "final_review"
      && result.message === "Final review failed." && reviews === 2,
    JSON.stringify({outcome: result.outcome, step: result.step, reviews}));
  check("behavior: speckit over-budget rounds each ran a fix pass first",
    JSON.stringify(events) === JSON.stringify(["fix:1", "review:1", "fix:2", "review:2"]),
    JSON.stringify(events));
}

// ── Behavioural: gate-green named argument (mission 062 task 1.3) ──
// A timeout-only initial review covered by the green Set is accepted without
// a fix pass; the new gateGreenFiles argument is what carries that evidence.
{
  const state = {};
  let fix = 0;
  const result = await runFinalReviewFixRounds({
    state, policy: {},
    initialReview: {status: "completed", review: {decision: "INCOMPLETE", findings: ["timed out running test-foo.mjs"]}},
    initialEvidenceRefusal: null,
    initialFindings: ["timed out running test-foo.mjs"],
    gateGreenFiles: new Set(["test-foo.mjs"]),
    saveState: () => {},
    deps: {
      runFixPass: async () => { fix += 1; },
      runGate: async () => null,
      runFinalReview: async () => FAIL,
      checkEvidenceRefusal: () => null,
    },
  });
  check("behavior: green Set via gateGreenFiles accepts timeout-only initial without a fix pass",
    result.outcome === "passed" && fix === 0,
    JSON.stringify({outcome: result.outcome, fix}));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("final-review fix-round wiring tests passed");